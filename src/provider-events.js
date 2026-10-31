import { hash, normalize, slug, text } from "./util.js";
import { eventDurationMinutes } from "./dlhd.js";

// Provider-sourced events.
//
// Many IPTV providers publish every live event on a numbered "slot" channel and
// put the real title (and often a start timestamp) in square brackets:
//
//   US| PRIME US 007 [Canelo Alvarez vs. Christian Mbilli (2026-10-31 15:58:00)]
//   PPV| LIVE EVENT 02 [10am Canelo v Mbilli]
//
// DLHD stays the authority: rows that match a DLHD event are handled by the
// normal matcher. This module only deals with the remaining rows, so events DLHD
// does not list (or lists under a different title) are not silently dropped.
// Rows describing the same event are clustered into one canonical event, and
// clusters that match a standalone DLHD event are attached to it instead of
// creating a duplicate channel.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

const PLACEHOLDER_RE = /^(?:event\s*only|no\s+event.*|live\s+during\s+events?\s+only|bk\d*|backup\d*|alt\d*|offline|off\s*air|n\/?a|tba|tbc|tbd|hd|fhd|uhd|sd|\d+p?|[a-z]{2}|bg|km|ppv|live)$/i;
const GENERIC_TITLE_RE = /^(?:event|ppv|live|channel|stream|feed|multifeed|tba|tbc|no event|coming soon|live[\s-]*events?|back[\s-]?up|events?\s*only|(?:nur|only)\s+(?:w[aä]hrend|during)\b.*|no\s+(?:games?|matches?|events?)\b.*|nessun\s+evento.*|aucun\s+[eé]v[eé]nement.*)(?:\s+\d{1,3})?$/i;
const QUALITY_PREFIX_RE = /^(?:(?:hevc|fhd|uhd|4k|hd|sd|h\.?26[45]|1080p?|720p?)\s+)+/i;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LEADING_TAG_RE = /^\(\s*(?:hd|fhd|uhd|sd|4k|hq|[a-zçéèêíóúñ]{2,12})\s*\)\s*/i;
const MATCHUP_SPLIT_RE = /\s+(?:vs\.?|v\.?|@|x|at)\s+/i;
const QUALIFIERS = [
  ["prelims", /\b(?:prelims?|preliminar[ie]s?|preliminaries|early\s+prelims?)\b/i],
  ["press-conference", /\b(?:press\s+conference|conferencia\s+de\s+prensa|conferenza\s+stampa|conf[eé]rence\s+de\s+presse)\b/i],
  ["weigh-in", /\b(?:weigh[\s-]*ins?|pesaje|pesagem)\b/i],
  ["free-fights", /\b(?:peleas\s+gratis|free\s+fights?|combats?\s+gratuits?)\b/i],
  ["replay", /\b(?:replays?|highlights?|rediffusion|repetici[oó]n|re-?air)\b/i],
  ["women", /\b(?:women'?s?|femen[ií]n[oa]s?|f[eé]minin[ea]?|donne|frauen|damen|ladies)\b/i],
  ["youth", /\bu-?(?:1\d|2[0-3])\b/i],
  ["countdown", /\b(?:countdown|pre[\s-]?show|pre[\s-]?fight|post[\s-]?fight|post[\s-]?show)\b/i],
];
const NOISE_TOKENS = new Set(["the", "of", "de", "la", "le", "el", "fc", "cf", "sc", "ac", "afc", "live", "hd", "fhd", "sd", "uhd"]);

export const DEFAULT_PROVIDER_EVENT_GROUPS = "\\bppv\\b|live\\s*events?|\\bevents?\\b|\\bevento\\b|\\bdazn\\b";

// ---------------------------------------------------------------------------
// Time zone helpers
// ---------------------------------------------------------------------------

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function zoneParts(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function zoneOffsetMs(ms, zone) {
  const p = zoneParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function calendarValid(year, month, day, hour, minute, second = 0) {
  if (!(month >= 1 && month <= 12 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59)) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Wall-clock time in `zone` -> epoch milliseconds, or null for an impossible
 * calendar date (Feb 30, hour 25...). A wall-clock time skipped by a DST jump
 * resolves to the instant just after the jump; a repeated hour resolves to the
 * first occurrence.
 */
export function zonedTimeMs(zone, year, month, day, hour, minute, second = 0) {
  if (!calendarValid(year, month, day, hour, minute, second)) return null;
  const tz = validZone(zone);
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = base;
  for (let i = 0; i < 2; i++) guess = base - zoneOffsetMs(guess, tz);
  return guess;
}

function to24h(hour, ampm) {
  let h = Number(hour);
  const suffix = String(ampm || "").toLowerCase();
  if (h > 12) return h; // "17:45 pm" is already 24h.
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  return h;
}

/** Time of day with no date: pick the occurrence (yesterday/today/tomorrow) closest to `now`. */
function nearestOccurrenceMs(zone, now, hour, minute) {
  const tz = validZone(zone);
  const today = zoneParts(now, tz);
  let best = null;
  for (const delta of [-1, 0, 1]) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + delta));
    const ms = zonedTimeMs(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
    if (best == null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best;
}

/** Clock time on a named weekday: the occurrence closest to `now`. */
function nearestWeekdayMs(zone, now, weekday, hour, minute) {
  const tz = validZone(zone);
  const today = zoneParts(now, tz);
  let best = null;
  for (let delta = -3; delta <= 10; delta++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + delta));
    if (day.getUTCDay() !== weekday) continue;
    const ms = zonedTimeMs(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
    if (best == null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best;
}

/**
 * "May 4th 4:00PM": month/day without a year; use the year that lands closest to
 * `now`. When a weekday is also given, only years in which that date really falls
 * on that weekday qualify; a contradictory pair yields null instead of a guess.
 */
function monthDayMs(zone, now, month, day, hour, minute, weekday = null) {
  const tz = validZone(zone);
  const year = zoneParts(now, tz).year;
  let best = null;
  for (const y of [year - 1, year, year + 1]) {
    if (weekday != null && new Date(Date.UTC(y, month - 1, day)).getUTCDay() !== weekday) continue;
    const ms = zonedTimeMs(tz, y, month, day, hour, minute);
    if (ms == null) continue;
    if (best == null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

const MAX_ROW_NAME_LENGTH = 600;
const MAX_TITLE_LENGTH = 200;

/** Text of the last "[...]" pair, found by scanning from the end (no per-match allocation). */
function lastBracket(value) {
  const source = String(value || "");
  const close = source.lastIndexOf("]");
  if (close < 1) return "";
  const open = source.lastIndexOf("[", close);
  return open < 0 ? "" : text(source.slice(open + 1, close));
}

function qualifierOf(value) {
  const hits = QUALIFIERS.filter(([, re]) => re.test(value)).map(([key]) => key);
  return hits.sort().join("+");
}

function stripQualifiers(value) {
  let out = String(value || "");
  for (const [, re] of QUALIFIERS) out = out.replace(new RegExp(`\\s*[:\\-–]?\\s*${re.source}`, "gi"), " ");
  return text(out.replace(/[:\-–]\s*$/, ""));
}

/**
 * Parse one provider row. Returns null when the row is not a real, titled event.
 *
 * `start` is only set when the row itself carries a time. Events without one are
 * resolved later (sibling rows, DLHD, or first-seen fallback).
 */
export function parseProviderEventRow(row, options = {}) {
  const { groupRe = null } = options;
  // Cheapest rejection first: the group gate runs before any title parsing.
  if (groupRe && !groupRe.test(String(row?.group || ""))) return null;
  // The display name and tvg-name are tried independently: either may be the
  // one carrying the bracketed title.
  const names = [...new Set([row?.name, row?.tvgName].map((value) => text(value)).filter(Boolean))];
  for (const name of names) {
    if (name.length > MAX_ROW_NAME_LENGTH) continue;
    const parsed = parseEventName(name, row, options);
    if (parsed) return parsed;
  }
  return null;
}

function parseEventName(raw, row, { now = Date.now(), timezone = "UTC", groupRe = null } = {}) {
  let inner = lastBracket(raw);
  if (!inner) return null;
  if (PLACEHOLDER_RE.test(inner) || /\b(?:no\s+event|event\s+only|live\s+during\s+events?)\b/i.test(inner)) return null;

  let start = null;
  let timeSource = null;

  // Full timestamp, optionally with a "Z" / "+01:00" offset; without one it is
  // wall-clock time in the configured provider time zone.
  const iso = /\(\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\s*\)/i.exec(inner);
  if (iso) {
    const parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] || 0)];
    if (iso[7]) {
      const offset = /^([+-])(\d{2}):?(\d{2})?$/.exec(iso[7]);
      const offsetMs = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] || 0)) * 60_000 : 0;
      start = calendarValid(...parts) ? Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]) - offsetMs : null;
    } else {
      start = zonedTimeMs(timezone, ...parts);
    }
    if (start != null) timeSource = "title-timestamp";
    inner = text(inner.replace(iso[0], " "));
  }

  // Month/day with a time, with or without a weekday and the provider's
  // "| UPCOMING |" marker: "Sun May 4th 4:00PM", "May 4 at 16:00".
  inner = inner.replace(/\*?\s*\|\s*UPCOMING\s*\|/i, " ");
  const dated = /(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(ET|EST|EDT|CT|CST|CDT|PT|PST|PDT|MT|MST|MDT|BST|CET|CEST|GMT|UTC))?(?![\w:])/i.exec(inner);
  if (dated && (dated[5] != null || dated[6])) {
    // A US/EU zone abbreviation means the clock is not in the configured zone: strip it, but do not guess.
    if (start == null && !dated[7]) {
      const weekday = dated[1] ? WEEKDAYS.indexOf(dated[1].toLowerCase()) : null;
      const month = MONTHS.get(dated[2].toLowerCase());
      start = monthDayMs(timezone, now, month, Number(dated[3]), to24h(dated[4], dated[6]), Number(dated[5] || 0), weekday);
      if (start != null) timeSource = "title-date";
    }
    inner = text(inner.replace(dated[0], " "));
  }

  inner = inner.replace(LEADING_TAG_RE, "").replace(QUALITY_PREFIX_RE, "");
  inner = text(inner.replace(/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*[-:|]\s*/i, ""));

  const leadingClock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*[-:|]?\s*/i.exec(inner);
  if (leadingClock) {
    if (start == null) {
      start = nearestOccurrenceMs(timezone, now, to24h(leadingClock[1], leadingClock[3]), Number(leadingClock[2] || 0));
      timeSource = "title-clock";
    }
    inner = inner.slice(leadingClock[0].length);
  }
  const lead24 = /^([01]?\d|2[0-3])[:.]([0-5]\d)\s+(?=\S)/.exec(inner);
  if (lead24) {
    if (start == null) {
      start = nearestOccurrenceMs(timezone, now, Number(lead24[1]), Number(lead24[2]));
      timeSource = "title-clock";
    }
    inner = inner.slice(lead24[0].length);
  }
  // "Celtic 15:00 Dunfermline": a clock between two team names stands in for "vs".
  const midClock = !MATCHUP_SPLIT_RE.test(inner) ? /^(.+?)\s+([01]?\d|2[0-3])[:.]([0-5]\d)\s+(.+)$/.exec(inner) : null;
  if (midClock) {
    if (start == null) {
      start = nearestOccurrenceMs(timezone, now, Number(midClock[2]), Number(midClock[3]));
      timeSource = "title-clock";
    }
    inner = `${midClock[1]} vs ${midClock[4]}`;
  }
  const trailingClock = /\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?:\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?)?\s*$/i.exec(inner);
  // A bare trailing number ("Round 3") is not a clock; need a colon, am/pm or a weekday.
  if (trailingClock && (trailingClock[2] != null || trailingClock[3] || trailingClock[4])) {
    if (start == null) {
      const hour = to24h(trailingClock[1], trailingClock[3]);
      const minute = Number(trailingClock[2] || 0);
      if (trailingClock[4]) {
        start = nearestWeekdayMs(timezone, now, WEEKDAYS.indexOf(trailingClock[4].toLowerCase()), hour, minute);
        timeSource = "title-weekday";
      } else {
        start = nearestOccurrenceMs(timezone, now, hour, minute);
        timeSource = "title-clock";
      }
    }
    inner = inner.slice(0, trailingClock.index);
  }

  inner = text(inner.replace(LEADING_TAG_RE, "").replace(QUALITY_PREFIX_RE, "").replace(/^[-:|\s]+|[-:|\s]+$/g, ""));
  if (!inner || !/[a-z]/i.test(inner) || GENERIC_TITLE_RE.test(inner)) return null;

  const pipe = inner.split(/\s+\|\s+/).map(text).filter(Boolean);
  const title = pipe[0];
  const competition = pipe.slice(1).join(" | ");
  if (!title || title.length < 3 || title.length > MAX_TITLE_LENGTH || GENERIC_TITLE_RE.test(title) || PLACEHOLDER_RE.test(title)) return null;

  const matchup = MATCHUP_SPLIT_RE.test(title);
  // A bare "[SEC NETWORK]" with no time or fixture is never an event, unless the
  // caller restricted rows to curated PPV / live-event groups (the group gate above).
  if (start == null && !matchup && !groupRe) return null;

  return {
    title,
    competition,
    qualifier: qualifierOf(`${title} ${competition}`),
    start,
    timeSource,
    matchup,
    group: text(row?.group),
  };
}

// ---------------------------------------------------------------------------
// Signatures / clustering
// ---------------------------------------------------------------------------

function sideTokens(value) {
  return new Set(normalize(value).split(" ").filter((t) => t.length > 1 && !NOISE_TOKENS.has(t)));
}

function isSubset(a, b) {
  if (!a.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

export function eventSignature(title, qualifier = "") {
  const base = stripQualifiers(title);
  const parts = base.split(MATCHUP_SPLIT_RE).map(text).filter(Boolean);
  if (parts.length === 2) {
    const a = sideTokens(parts[0]);
    const b = sideTokens(parts[1]);
    if (a.size && b.size) return { kind: "match", a, b, qualifier };
  }
  return { kind: "title", tokens: sideTokens(base.replace(/[:|]/g, " ")), qualifier };
}

export function signaturesMatch(x, y) {
  if (!x || !y || x.qualifier !== y.qualifier || x.kind !== y.kind) return false;
  const related = (p, q) => isSubset(p, q) || isSubset(q, p);
  if (x.kind === "match") {
    return (related(x.a, y.a) && related(x.b, y.b)) || (related(x.a, y.b) && related(x.b, y.a));
  }
  if (!x.tokens.size || !y.tokens.size) return false;
  if (x.tokens.size === y.tokens.size && isSubset(x.tokens, y.tokens)) return true;
  const [small, large] = x.tokens.size <= y.tokens.size ? [x.tokens, y.tokens] : [y.tokens, x.tokens];
  // Containment only for multi-word titles, and numbers (UFC 334 vs UFC 335) must agree.
  const numbers = (set) => [...set].filter((t) => /\d/.test(t)).sort().join(",");
  return small.size >= 2 && isSubset(small, large) && large.size - small.size <= 1 && numbers(small) === numbers(large);
}

function signatureTokens(signature) {
  return signature.kind === "match" ? [...signature.a, ...signature.b] : [...signature.tokens];
}

function serializeSignature(signature) {
  return signature.kind === "match"
    ? { kind: "match", qualifier: signature.qualifier, a: [...signature.a], b: [...signature.b] }
    : { kind: "title", qualifier: signature.qualifier, tokens: [...signature.tokens] };
}

function deserializeSignature(stored) {
  if (!stored || typeof stored !== "object") return null;
  const qualifier = String(stored.qualifier || "");
  if (stored.kind === "match" && Array.isArray(stored.a) && Array.isArray(stored.b)) {
    return { kind: "match", qualifier, a: new Set(stored.a), b: new Set(stored.b) };
  }
  if (stored.kind === "title" && Array.isArray(stored.tokens)) return { kind: "title", qualifier, tokens: new Set(stored.tokens) };
  return null;
}

const MAX_START_GAP_MS = 8 * HOUR;

function startsCompatible(a, b) {
  return a == null || b == null || Math.abs(a - b) <= MAX_START_GAP_MS;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function signatureSides(signature) {
  return signature.kind === "match" ? [signature.a, signature.b] : [signature.tokens];
}

function smallest(set) {
  let best = null;
  for (const token of set) if (best == null || token < best) best = token;
  return best;
}

/**
 * Group rows that describe the same event.
 *
 * Two signatures match only when, side by side, one token set contains the other.
 * So a matching cluster is always reachable one of two ways, and both lookups use
 * small buckets: (1) the item side is the smaller one, so any of its tokens occurs
 * in the cluster (use the rarest); (2) the cluster side is the smaller one, so its
 * smallest token occurs among the item's tokens. Common words ("team", "club")
 * therefore never force a scan of every cluster.
 */
export function clusterProviderEvents(items) {
  const clusters = [];
  const byAll = new Map();     // every token of a cluster's signature -> clusters
  const byChosen = new Map();  // smallest token of each cluster side -> clusters
  const push = (map, key, cluster) => {
    const list = map.get(key);
    if (list) list.push(cluster); else map.set(key, [cluster]);
  };
  for (const item of items) {
    const signature = eventSignature(item.parsed.title, item.parsed.qualifier);
    const sides = signatureSides(signature);
    const candidates = new Set();
    for (const side of sides) {
      let rarest = null;
      for (const token of side) {
        const size = byAll.get(token)?.length ?? 0;
        if (rarest == null || size < rarest.size) rarest = { token, size };
      }
      if (rarest) for (const candidate of byAll.get(rarest.token) || []) candidates.add(candidate);
      for (const token of side) for (const candidate of byChosen.get(token) || []) candidates.add(candidate);
    }
    let cluster = null;
    for (const candidate of candidates) {
      if (signaturesMatch(candidate.signature, signature) && startsCompatible(candidate.anchor, item.parsed.start)) {
        cluster = candidate;
        break;
      }
    }
    if (!cluster) {
      cluster = { signature, items: [], starts: [], anchor: null, start: null, core: null };
      clusters.push(cluster);
      for (const token of signatureTokens(signature)) push(byAll, token, cluster);
      for (const side of sides) push(byChosen, smallest(side), cluster);
    }
    cluster.items.push(item);
    // Tokens every member agrees on: an order-independent basis for the event id.
    const tokens = new Set(signatureTokens(signature));
    cluster.core = cluster.core ? new Set([...cluster.core].filter((t) => tokens.has(t))) : tokens;
    if (item.parsed.start != null) {
      cluster.starts.push(item.parsed.start);
      if (cluster.anchor == null) cluster.anchor = item.parsed.start;
    }
  }
  for (const cluster of clusters) cluster.start = cluster.starts.length ? median(cluster.starts) : null;
  return clusters;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function displayTitle(cluster) {
  // Prefer the most informative (longest) title among members.
  return [...cluster.items.map((x) => x.parsed)]
    .sort((a, b) => b.title.length - a.title.length)[0];
}

function categoryFor(group) {
  return text(String(group || "").replace(/^[A-Z]{2,3}\s*\|\s*/, "")) || "Events";
}

function clockLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Rows already mapped to an event (directly or through EPG-assisted matching) are not provider-only events. */
export function excludeClaimedRows(items, mappedRows) {
  const claimed = new Set();
  for (const mapped of mappedRows || []) {
    if (mapped?.reference?.kind === "event") claimed.add(`${mapped.source?.id}|${mapped.row?.url}`);
  }
  return (items || []).filter((item) => !claimed.has(`${item.source?.id}|${item.row?.url}`));
}

/** A previously published provider-only event may be kept while its source is down, until its window ends. */
export function providerEventRetainable(channel, { now = Date.now(), tailMinutes = 60 } = {}) {
  if (channel?.referenceKind !== "event" || channel?.event?.source !== "provider") return false;
  const end = Number(channel.event.end);
  return Number.isFinite(end) && now <= end + tailMinutes * MINUTE;
}

// Registry: identity and time memory carried between refreshes.
const REAPPEAR_GAP_MS = 12 * HOUR;       // absent this long => the same title is a new occurrence
const REGISTRY_MAX_AGE_MS = 3 * 24 * HOUR;
const REGISTRY_MAX_ENTRIES = 2000;

function findPreviousIdentity(registry, signature, start, clockOnly) {
  for (const [id, entry] of Object.entries(registry || {})) {
    const stored = deserializeSignature(entry?.sig);
    if (!stored || !signaturesMatch(stored, signature)) continue;
    // A clock-only time ("10am") is re-derived as "the nearest 10am" on each
    // refresh, so it can move by a day without being a different event.
    const sameClock = clockOnly && entry.clock === true;
    if (sameClock || startsCompatible(Number(entry.start) || null, start)) return { id, entry };
  }
  return null;
}

/**
 * Turn scanned provider rows into event mappings.
 *
 * items:            [{ source, row, parsed }] for rows DLHD did not match.
 * dlhdEvents:       standalone DLHD event references (clusters that match one are attached to it).
 * previousRegistry: { [eventId]: { firstSeen, lastSeen, start, sig } }. It keeps an event's
 *                   identity stable across refreshes (whichever provider row arrives first),
 *                   remembers the estimated start of events whose rows carry no date, and
 *                   stops an expired event from being re-created.
 */
export function resolveProviderEvents({
  items = [],
  dlhdEvents = [],
  previousRegistry = {},
  now = Date.now(),
  leadMinutes = 240,
  tailMinutes = 60,
  maxEvents = 150,
} = {}) {
  const rows = [];
  const refs = [];
  const built = [];
  const registry = {};
  const status = {
    candidateRows: items.length,
    clusters: 0,
    attachedToDlhd: 0,
    created: 0,
    expired: 0,
    notYetActive: 0,
    estimatedTimes: 0,
    capped: 0,
    mappings: 0,
  };

  const dlhdSignatures = dlhdEvents.map((ref) => ({
    ref,
    signature: eventSignature(ref.name, qualifierOf(ref.name)),
  }));

  for (const cluster of clusterProviderEvents(items)) {
    status.clusters += 1;
    const lead = displayTitle(cluster);

    const attached = dlhdSignatures.find((candidate) =>
      signaturesMatch(candidate.signature, cluster.signature) && startsCompatible(candidate.ref.start ?? null, cluster.start));
    if (attached) {
      status.attachedToDlhd += 1;
      for (const item of cluster.items) rows.push({ source: item.source, row: item.row, reference: attached.ref, matchReason: "provider-event-dlhd" });
      continue;
    }

    const category = categoryFor(lead.group);
    const dated = cluster.items.some((x) => x.parsed.timeSource === "title-timestamp" || x.parsed.timeSource === "title-date");
    const clockOnly = !dated && cluster.start != null;

    // Identity: reuse the previous id for the same event (matched by signature, not
    // by which row came first); otherwise mint one from the cluster's own tokens.
    const previous = findPreviousIdentity(previousRegistry, cluster.signature, cluster.start, clockOnly);
    const continuing = previous && now - Number(previous.entry.lastSeen || 0) <= REAPPEAR_GAP_MS;
    let id = previous?.id;
    if (!id) {
      const core = cluster.core?.size ? [...cluster.core] : signatureTokens(cluster.signature);
      const sigKey = normalize(`${core.sort().join(" ")}|${cluster.signature.qualifier}`);
      const dayKey = dated ? new Date(cluster.start).toISOString().slice(0, 10) : "";
      id = `pevent-${slug(lead.title).slice(0, 48)}-${hash(`${sigKey}|${dayKey}`, 8)}`;
    }
    const short = id.replace(/^pevent-/, "").replace(/-[0-9a-f]{8}$/, "");
    const suffix = id.slice(-8);

    let start = cluster.start;
    let timeSource = start == null ? null : (cluster.items.find((x) => x.parsed.start != null)?.parsed.timeSource || "title-timestamp");
    let firstSeen = continuing ? Number(previous.entry.firstSeen) || now : now;
    if (clockOnly && continuing && Number.isFinite(Number(previous.entry.start))) {
      // "10am" with no date: keep the day it was first resolved to instead of
      // re-deriving "the nearest 10am" on every refresh (which drifts across midnight).
      start = Number(previous.entry.start);
    }
    const estimated = start == null;
    if (estimated) {
      // No row carries a time and DLHD does not list the event: treat it as
      // starting when it first appeared in the provider playlist.
      start = continuing && Number.isFinite(Number(previous.entry.start)) ? Number(previous.entry.start) : firstSeen;
      timeSource = "first-seen";
      status.estimatedTimes += 1;
    }
    const end = start + eventDurationMinutes(category, lead.title) * MINUTE;

    // Remember identity/time only where it is needed: events that were published,
    // or whose time is an estimate/clock guess (so an expired slot is not re-created).
    const expired = now > end + tailMinutes * MINUTE;
    const notYet = now < start - leadMinutes * MINUTE;
    if (estimated || clockOnly || (!expired && !notYet)) {
      registry[id] = { firstSeen, lastSeen: now, start, clock: clockOnly, sig: serializeSignature(cluster.signature) };
    }
    if (expired) { status.expired += 1; continue; }
    if (notYet) { status.notYetActive += 1; continue; }

    const name = lead.competition ? `${lead.competition}: ${lead.title}` : lead.title;
    const aliases = [...new Set([lead.title, ...cluster.items.map((x) => x.parsed.title)])];
    const ref = {
      kind: "event",
      source: "provider",
      id,
      key: normalize(`event|${id}`),
      tvgId: `justone.event.${short}.${suffix}`,
      dlhdId: "",
      name,
      logo: "",
      aliases,
      group: `Events | ${category}`,
      linkedChannels: [],
      linkedStaticChannels: [],
      start,
      end,
      time: clockLabel(start),
      category,
      upcoming: start > now,
      timeSource,
      timeEstimated: estimated,
    };
    built.push({
      ref,
      rows: cluster.items.map((item) => ({ source: item.source, row: item.row, reference: ref, matchReason: "provider-event" })),
    });
  }

  // Safety cap: keep the events carried by the most slots (the big ones), then the
  // ones closest to now, so a very large provider list cannot flood the lineup.
  built.sort((a, b) => b.rows.length - a.rows.length || Math.abs(a.ref.start - now) - Math.abs(b.ref.start - now));
  for (const entry of built.slice(0, maxEvents)) {
    refs.push(entry.ref);
    rows.push(...entry.rows);
  }
  status.capped = Math.max(0, built.length - maxEvents);
  status.created = refs.length;

  // Carry over entries not seen this refresh for a short while (so a brief provider
  // outage does not forget an estimated start), then bound the whole registry.
  for (const [id, entry] of Object.entries(previousRegistry || {})) {
    if (!registry[id] && now - Number(entry?.lastSeen || 0) < REGISTRY_MAX_AGE_MS) registry[id] = entry;
  }
  const entries = Object.entries(registry).sort((a, b) => Number(b[1].lastSeen) - Number(a[1].lastSeen)).slice(0, REGISTRY_MAX_ENTRIES);

  status.mappings = rows.length;
  return { rows, refs, registry: Object.fromEntries(entries), status };
}
