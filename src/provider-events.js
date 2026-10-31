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

/** Wall-clock time in `zone` -> epoch milliseconds. */
export function zonedTimeMs(zone, year, month, day, hour, minute, second = 0) {
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

/** "May 4th 4:00PM": month/day without a year; use the year that lands closest to `now`. */
function monthDayMs(zone, now, month, day, hour, minute) {
  const tz = validZone(zone);
  const year = zoneParts(now, tz).year;
  let best = null;
  for (const y of [year - 1, year, year + 1]) {
    const ms = zonedTimeMs(tz, y, month, day, hour, minute);
    if (best == null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function lastBracket(value) {
  const matches = [...String(value || "").matchAll(/\[([^\[\]]+)\]/g)];
  return matches.length ? text(matches[matches.length - 1][1]) : "";
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
export function parseProviderEventRow(row, { now = Date.now(), timezone = "UTC", groupRe = null } = {}) {
  const raw = text(row?.tvgName || row?.name);
  let inner = lastBracket(raw);
  if (!inner) return null;
  if (PLACEHOLDER_RE.test(inner) || /\b(?:no\s+event|event\s+only|live\s+during\s+events?)\b/i.test(inner)) return null;

  let start = null;
  let timeSource = null;

  const iso = /\(\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*\)/.exec(inner);
  if (iso) {
    start = zonedTimeMs(timezone, Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] || 0));
    timeSource = "title-timestamp";
    inner = text(inner.replace(iso[0], " "));
  }

  const upcoming = /\*?\s*\|\s*UPCOMING\s*\|\s*(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(inner);
  if (upcoming) {
    const month = MONTHS.get(upcoming[1].slice(0, 3).toLowerCase());
    if (month && start == null) {
      start = monthDayMs(timezone, now, month, Number(upcoming[2]), to24h(upcoming[3], upcoming[5]), Number(upcoming[4]));
      timeSource = "title-date";
    }
    inner = text(inner.replace(upcoming[0], " "));
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
  if (!title || title.length < 3 || GENERIC_TITLE_RE.test(title) || PLACEHOLDER_RE.test(title)) return null;

  const matchup = MATCHUP_SPLIT_RE.test(title);
  // Only configured PPV / live-event groups are considered: providers also bracket
  // titles in huge catch-up style groups (FLO, ESPN+ mats and brackets) that would
  // swamp the lineup. A bare "[SEC NETWORK]" with no time or fixture is never an event.
  if (groupRe && !groupRe.test(String(row?.group || ""))) return null;
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

const MAX_START_GAP_MS = 8 * HOUR;

function startsCompatible(a, b) {
  return a == null || b == null || Math.abs(a - b) <= MAX_START_GAP_MS;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function clusterProviderEvents(items) {
  const clusters = [];
  for (const item of items) {
    const signature = eventSignature(item.parsed.title, item.parsed.qualifier);
    let cluster = null;
    for (const candidate of clusters) {
      if (signaturesMatch(candidate.signature, signature) && startsCompatible(candidate.start, item.parsed.start)) {
        cluster = candidate;
        break;
      }
    }
    if (!cluster) {
      cluster = { signature, items: [], start: null };
      clusters.push(cluster);
    }
    cluster.items.push(item);
    const known = cluster.items.map((x) => x.parsed.start).filter((x) => x != null);
    cluster.start = known.length ? median(known) : null;
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function displayTitle(cluster) {
  // Prefer the most informative (longest) title among members that agree on the qualifier.
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

/**
 * Turn scanned provider rows into event mappings.
 *
 * items:            [{ source, row, parsed }] for rows DLHD did not match.
 * dlhdEvents:       standalone DLHD event references (clusters that match one are attached to it).
 * previousRegistry: { [eventId]: { firstSeen } } carried between refreshes so a
 *                   start time can be estimated for events whose rows carry none.
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
    const sigKey = normalize(`${[...(cluster.signature.tokens || [...cluster.signature.a, "vs", ...cluster.signature.b])].sort().join(" ")}|${cluster.signature.qualifier}`);
    const dayKey = cluster.start == null ? "" : new Date(cluster.start).toISOString().slice(0, 10);
    const short = slug(lead.title).slice(0, 48);
    const suffix = hash(`${sigKey}|${dayKey}`, 8);
    const id = `pevent-${short}-${suffix}`;

    let start = cluster.start;
    let timeSource = start == null ? null : (cluster.items.find((x) => x.parsed.start != null)?.parsed.timeSource || "title-timestamp");
    const firstSeen = Number(previousRegistry?.[id]?.firstSeen) || now;
    if (start == null) {
      // No row carries a time and DLHD does not list the event: the event is
      // treated as starting when it first appeared in the provider playlist.
      start = firstSeen;
      timeSource = "first-seen";
      status.estimatedTimes += 1;
    }
    const end = start + eventDurationMinutes(category, lead.title) * MINUTE;

    // Remember the event even when it is outside its window, so a stale slot
    // that keeps its title in the playlist cannot be re-created as "new".
    registry[id] = { firstSeen, lastSeen: now };
    if (now > end + tailMinutes * MINUTE) { status.expired += 1; continue; }
    if (now < start - leadMinutes * MINUTE) { status.notYetActive += 1; continue; }

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
      timeEstimated: timeSource === "first-seen",
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

  // Keep first-seen memory for a while so estimated windows stay stable across refreshes.
  for (const [id, entry] of Object.entries(previousRegistry || {})) {
    if (!registry[id] && now - Number(entry?.lastSeen || entry?.firstSeen || 0) < 7 * 24 * HOUR) registry[id] = entry;
  }

  status.mappings = rows.length;
  return { rows, refs, registry, status };
}
