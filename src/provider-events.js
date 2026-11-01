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

function wallClockMatches(ms, zone, year, month, day, hour, minute, second) {
  const p = zoneParts(ms, zone);
  return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second;
}

/**
 * Wall-clock time in `zone` -> epoch milliseconds, or null for an impossible
 * calendar date (Feb 30, hour 25...).
 *
 * DST policy (same as java.time): a repeated hour (clocks going back) resolves to
 * its first occurrence; a time that does not exist (clocks going forward) is
 * shifted forward by the length of the gap, e.g. London 01:30 on the spring change
 * is 02:30 BST, New York 02:30 is 03:30 EDT.
 */
export function zonedTimeMs(zone, year, month, day, hour, minute, second = 0) {
  if (!calendarValid(year, month, day, hour, minute, second)) return null;
  const tz = validZone(zone);
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  const beforeOffset = zoneOffsetMs(base - 24 * HOUR, tz);
  const afterOffset = zoneOffsetMs(base + 24 * HOUR, tz);
  const first = base - beforeOffset;
  if (wallClockMatches(first, tz, year, month, day, hour, minute, second)) return first;
  const second_ = base - afterOffset;
  if (wallClockMatches(second_, tz, year, month, day, hour, minute, second)) return second_;
  return first; // inside a DST gap
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

  // An explicit schedule that is present but unusable (impossible date, bad offset,
  // weekday that contradicts the date, a zone we cannot honour) makes the row
  // ineligible: it must not silently turn into an event that "starts now".
  let explicitButInvalid = false;

  // Full timestamp, optionally with a "Z" / "+01:00" offset; without one it is
  // wall-clock time in the configured provider time zone.
  const iso = /\(\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?\s*\)/i.exec(inner);
  if (iso) {
    const parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] || 0)];
    if (iso[7]) {
      const offset = /^([+-])(\d{2}):?(\d{2})?$/.exec(iso[7]);
      const hours = offset ? Number(offset[2]) : 0;
      const minutes = offset ? Number(offset[3] || 0) : 0;
      const offsetOk = !offset || (hours <= 14 && minutes <= 59);
      const offsetMs = offset ? (offset[1] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000 : 0;
      start = offsetOk && calendarValid(...parts) ? Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]) - offsetMs : null;
    } else {
      start = zonedTimeMs(timezone, ...parts);
    }
    if (start != null) timeSource = "title-timestamp";
    else explicitButInvalid = true;
    inner = text(inner.replace(iso[0], " "));
  }

  // Month/day with a time, with or without a weekday and the provider's
  // "| UPCOMING |" marker: "Sun May 4th 4:00PM", "May 4 at 16:00". Skipped when a
  // full timestamp was already read, so date-like words in a title ("The Dec 25
  // 5pm Showdown") are never stripped.
  inner = inner.replace(/\*?\s*\|\s*UPCOMING\s*\|/i, " ");
  const dated = start == null && !explicitButInvalid
    ? /(?:\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(ET|EST|EDT|CT|CST|CDT|PT|PST|PDT|MT|MST|MDT|BST|CET|CEST|GMT|UTC))?(?![\w:])/i.exec(inner)
    : null;
  if (dated && (dated[5] != null || dated[6])) {
    if (dated[7]) {
      explicitButInvalid = true; // a clock in another zone than the configured one: not guessed
    } else {
      const weekday = dated[1] ? WEEKDAYS.indexOf(dated[1].toLowerCase()) : null;
      const month = MONTHS.get(dated[2].toLowerCase());
      start = monthDayMs(timezone, now, month, Number(dated[3]), to24h(dated[4], dated[6]), Number(dated[5] || 0), weekday);
      if (start != null) timeSource = "title-date";
      else explicitButInvalid = true;
    }
    inner = text(inner.replace(dated[0], " "));
  }
  if (explicitButInvalid) return null;

  // "Sat 7 pm", "Saturday 19:00", "7pm Sat": a weekday next to a clock, in either
  // order and anywhere in the title, is one expression (the day it names).
  const WD = "(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?";
  const weekdayFirst = new RegExp(`\\b${WD}\\.?,?\\s+(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?(?![\\w:.])`, "i").exec(inner);
  const weekdayLast = weekdayFirst ? null : new RegExp(`(?<![\\w:.])(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?\\s+${WD}\\b`, "i").exec(inner);
  const wc = weekdayFirst
    ? { day: weekdayFirst[1], hour: weekdayFirst[2], minute: weekdayFirst[3], ampm: weekdayFirst[4], whole: weekdayFirst[0] }
    : weekdayLast ? { day: weekdayLast[4], hour: weekdayLast[1], minute: weekdayLast[2], ampm: weekdayLast[3], whole: weekdayLast[0] } : null;
  // A bare number after a weekday ("Sun 5 Nations") is not a clock: it needs minutes or am/pm.
  if (wc && (wc.minute != null || wc.ampm)) {
    // An advertised time that is not a time ("Sat 25:00", "Sun 99pm") makes the row ineligible.
    if (to24h(wc.hour, wc.ampm) > 23 || Number(wc.minute || 0) > 59) return null;
    if (start == null) {
      start = nearestWeekdayMs(timezone, now, WEEKDAYS.indexOf(wc.day.toLowerCase()), to24h(wc.hour, wc.ampm), Number(wc.minute || 0));
      if (start == null) return null;
      timeSource = "title-weekday";
    }
    inner = text(inner.replace(wc.whole, " "));
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

export function startsCompatible(a, b) {
  return a == null || b == null || Math.abs(a - b) <= MAX_START_GAP_MS;
}

/** A row may join a cluster only if the cluster's whole start-time span stays within tolerance. */
function spanCompatible(cluster, start) {
  if (start == null || cluster.minStart == null) return true;
  return Math.max(cluster.maxStart, start) - Math.min(cluster.minStart, start) <= MAX_START_GAP_MS;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function signatureSides(signature) {
  return signature.kind === "match" ? [signature.a, signature.b] : [signature.tokens];
}

function signatureKey(signature) {
  const sides = signatureSides(signature).map((side) => [...side].sort().join(" "));
  return `${signature.kind}|${signature.qualifier}|${sides.sort().join("||")}`;
}

const UNTIMED_BUCKET = "u";
const BUCKET_MS = MAX_START_GAP_MS;

function timeBucket(start) {
  return start == null ? UNTIMED_BUCKET : Math.floor(start / BUCKET_MS);
}

/**
 * Candidate lookup for signature matching without comparing against everything.
 *
 * Two signatures match only when, side by side, one token set contains the other.
 * So a stored signature is always reachable one of two ways: (1) the query side is
 * the smaller one, so ANY of its tokens occurs in the stored signature (use the
 * one with the smallest bucket); (2) the stored side is the smaller one, so the
 * token chosen for it when it was added occurs in the query. Any ONE side of the
 * query reaches every true match, so the cheaper side is used. Choosing the
 * globally rarest token (`freq`) keeps buckets small even when every event shares
 * words such as "team" or "club".
 *
 * Payloads are also partitioned by a time bucket. A cluster's start times all lie
 * within one tolerance window, so a timed query only needs the buckets next to its
 * own start plus the untimed bucket; identical titles on distant dates are never
 * scanned against each other.
 */
function createSignatureIndex(freq) {
  const byAll = new Map();     // token -> Map(bucket -> payloads)
  const allCount = new Map();  // token -> payload count
  const byChosen = new Map();
  const chosenCount = new Map();
  const push = (map, counts, key, bucket, payload) => {
    let buckets = map.get(key);
    if (!buckets) { buckets = new Map(); map.set(key, buckets); }
    const list = buckets.get(bucket);
    if (list) { if (!list.includes(payload)) { list.push(payload); counts.set(key, (counts.get(key) || 0) + 1); } }
    else { buckets.set(bucket, [payload]); counts.set(key, (counts.get(key) || 0) + 1); }
  };
  const chosenToken = (side) => {
    let best = null;
    let bestFreq = Infinity;
    for (const token of side) {
      const f = freq.get(token) || 0;
      if (f < bestFreq || (f === bestFreq && token < best)) { best = token; bestFreq = f; }
    }
    return best;
  };
  const collect = (buckets, wanted, found, stats) => {
    if (!buckets) return;
    // A timed query reads only its neighbouring buckets (plus the untimed one); an
    // untimed query has no time to narrow by and reads them all.
    const lists = wanted
      ? [...wanted, UNTIMED_BUCKET].map((bucket) => buckets.get(bucket))
      : buckets.values();
    for (const list of lists) {
      if (!list) continue;
      for (const payload of list) { found.add(payload); if (stats) stats.candidates = (stats.candidates || 0) + 1; }
    }
  };
  return {
    add(signature, payload, bucket = UNTIMED_BUCKET) {
      for (const token of signatureTokens(signature)) push(byAll, allCount, token, bucket, payload);
      for (const side of signatureSides(signature)) push(byChosen, chosenCount, chosenToken(side), bucket, payload);
    },
    candidates(signature, start = null, stats = null) {
      const wanted = start == null ? null : new Set([timeBucket(start) - 1, timeBucket(start), timeBucket(start) + 1]);
      let best = null;
      let bestCost = Infinity;
      for (const side of signatureSides(signature)) {
        let rarest = null;
        let rarestSize = Infinity;
        let cost = 0;
        for (const token of side) {
          const size = allCount.get(token) ?? 0;
          if (size < rarestSize) { rarest = token; rarestSize = size; }
          cost += chosenCount.get(token) ?? 0;
        }
        cost += rarestSize === Infinity ? 0 : rarestSize;
        if (cost < bestCost) { best = { side, rarest }; bestCost = cost; }
      }
      const found = new Set();
      if (!best) return found;
      if (best.rarest != null) collect(byAll.get(best.rarest), wanted, found, stats);
      for (const token of best.side) collect(byChosen.get(token), wanted, found, stats);
      return found;
    },
  };
}

/**
 * Group rows that describe the same event.
 *
 * Rows are processed in a fixed order (most specific title first, then start time),
 * so the result does not depend on the order of providers. A row joins a cluster
 * only if it is compatible with every distinct title already in it, which keeps
 * abbreviations that merely bridge two different names ("Canelo vs Mbilli" between
 * "Canelo Alvarez vs Mbilli" and "Canelo Junior vs Mbilli") from chaining them
 * together, and only if the cluster's whole start-time span stays within tolerance.
 * `stats.comparisons` counts signature comparisons and `stats.candidates` the
 * candidates examined (used by tests).
 */
export function clusterProviderEvents(items, stats = null) {
  const entries = items.map((item) => {
    const signature = eventSignature(item.parsed.title, item.parsed.qualifier);
    return { item, signature, key: signatureKey(signature), size: signatureTokens(signature).length };
  });
  const freq = new Map();
  for (const entry of entries) for (const token of new Set(signatureTokens(entry.signature))) freq.set(token, (freq.get(token) || 0) + 1);
  entries.sort((a, b) => b.size - a.size
    || (a.item.parsed.title < b.item.parsed.title ? -1 : a.item.parsed.title > b.item.parsed.title ? 1 : 0)
    || (a.item.parsed.start ?? Infinity) - (b.item.parsed.start ?? Infinity) || 0
    || String(a.item.source?.id).localeCompare(String(b.item.source?.id))
    || String(a.item.row?.url).localeCompare(String(b.item.row?.url)));

  const clusters = [];
  const index = createSignatureIndex(freq);
  for (const { item, signature, key } of entries) {
    let cluster = null;
    for (const candidate of index.candidates(signature, item.parsed.start, stats)) {
      if (!spanCompatible(candidate, item.parsed.start)) continue;
      let compatible = true;
      for (const [knownKey, known] of candidate.sigs) {
        if (knownKey === key) continue;
        if (stats) stats.comparisons = (stats.comparisons || 0) + 1;
        if (!signaturesMatch(known, signature)) { compatible = false; break; }
      }
      if (compatible) { cluster = candidate; break; }
    }
    if (!cluster) {
      // The bucket is fixed by the first timed start: every later member lies within
      // one tolerance window of it, so lookups that include its neighbours find it.
      cluster = { signature, sigs: new Map(), items: [], starts: [], minStart: null, maxStart: null, start: null, core: null, bucket: timeBucket(item.parsed.start) };
      clusters.push(cluster);
    }
    if (!cluster.sigs.has(key)) {
      cluster.sigs.set(key, signature);
      index.add(signature, cluster, cluster.bucket);
    }
    cluster.items.push(item);
    // Tokens every member agrees on: an order-independent basis for the event id.
    const tokens = new Set(signatureTokens(signature));
    cluster.core = cluster.core ? new Set([...cluster.core].filter((t) => tokens.has(t))) : tokens;
    if (item.parsed.start != null) {
      cluster.starts.push(item.parsed.start);
      cluster.minStart = cluster.minStart == null ? item.parsed.start : Math.min(cluster.minStart, item.parsed.start);
      cluster.maxStart = cluster.maxStart == null ? item.parsed.start : Math.max(cluster.maxStart, item.parsed.start);
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

/** Two channels with the same id are the same occurrence only if their start times are compatible. */
export function sameProviderOccurrence(a, b) {
  const start = (channel) => (Number.isFinite(Number(channel?.event?.start)) ? Number(channel.event.start) : null);
  return startsCompatible(start(a), start(b));
}

// Registry: identity and time memory carried between refreshes.
const META_KEY = "__meta";
const REAPPEAR_GAP_MS = 12 * HOUR;       // absent from successful scans this long => a new occurrence
const REGISTRY_MAX_AGE_MS = 3 * 24 * HOUR;
const REGISTRY_MAX_ENTRIES = 1000;      // active events only; expired ones become tombstones
const TOMBSTONE_MAX_ENTRIES = 20000;
const CLOCK_TOLERANCE_MS = 2 * HOUR;

function clockOfDayDistance(a, b) {
  const diff = Math.abs(a - b) % (24 * HOUR);
  return Math.min(diff, 24 * HOUR - diff);
}

/**
 * Pair clusters with the identities remembered from earlier refreshes. Every pair
 * that could be the same occurrence is scored by how close the start times are,
 * and the closest pairs are assigned first, each identity at most once.
 */
function assignPreviousIdentities(clusters, previousRegistry) {
  const previous = [];
  const freq = new Map();
  for (const [id, entry] of Object.entries(previousRegistry || {})) {
    if (id === META_KEY) continue;
    const signature = deserializeSignature(entry?.sig);
    if (signature) previous.push({ id, entry, signature });
  }
  const index = createSignatureIndex(freq);
  for (const item of previous) index.add(item.signature, item);

  const pairs = [];
  clusters.forEach((cluster, clusterIndex) => {
    const clockOnly = cluster.clockOnly;
    for (const candidate of index.candidates(cluster.signature)) {
      if (!signaturesMatch(candidate.signature, cluster.signature)) continue;
      const prevStart = Number.isFinite(Number(candidate.entry.start)) ? Number(candidate.entry.start) : null;
      let distance;
      if (clockOnly && candidate.entry.clock === true && prevStart != null && cluster.start != null) {
        // "10am" is re-derived as the nearest 10am each refresh, so it may move by whole
        // days; it is the same event only if the clock time itself still agrees.
        distance = clockOfDayDistance(prevStart, cluster.start);
        if (distance > CLOCK_TOLERANCE_MS) continue;
      } else if (startsCompatible(prevStart, cluster.start)) {
        distance = prevStart == null || cluster.start == null ? 0 : Math.abs(prevStart - cluster.start);
      } else continue;
      pairs.push({ distance, clusterIndex, candidate });
    }
  });
  pairs.sort((a, b) => a.distance - b.distance || a.candidate.id.localeCompare(b.candidate.id) || a.clusterIndex - b.clusterIndex);
  const assigned = new Map();
  const taken = new Set();
  for (const pair of pairs) {
    if (assigned.has(pair.clusterIndex) || taken.has(pair.candidate.id)) continue;
    assigned.set(pair.clusterIndex, pair.candidate);
    taken.add(pair.candidate.id);
  }
  return assigned;
}

const MAX_TRACKED_SOURCES = 64;

const tombstoneKey = (signature) => hash(signatureKey(signature), 12);
const unionSources = (a, b) => (Array.isArray(a) && Array.isArray(b) ? [...new Set([...a, ...b])].slice(0, MAX_TRACKED_SOURCES) : null);

/**
 * Turn scanned provider rows into event mappings.
 *
 * items:            [{ source, row, parsed }] for rows DLHD did not match.
 * dlhdEvents:       standalone DLHD event references (clusters that match one are attached to it).
 * previousRegistry: { [eventId]: { firstSeen, lastSeen, start, clock, sources, goneAt, sig }, __meta }.
 *                   It keeps an event's identity stable across refreshes (whichever provider row
 *                   arrives first), remembers the estimated start of events whose rows carry no
 *                   date, and (as compact tombstones in __meta.tombs) stops an expired event from
 *                   being re-created without letting expired events crowd out new ones.
 *                   An id identifies a recurring programme slot: once a title is confirmed gone and
 *                   later returns, it is a new occurrence (new start) under the same id/tvg-id.
 * failedSourceIds:  sources that failed this refresh. A listing counts as "gone" only if a refresh
 *                   in which every source that carried it succeeded did not see it (`goneAt`); a
 *                   failed scan never confirms that, however the source behaves afterwards.
 *
 * Tombstones: { [leadSignatureHash]: { t: lastSeen, s: sources, m: member signature hashes, g: goneAt,
 *   u: 1 + f: firstSeen when the event was NOT admitted only because the registry was full } }.
 * A new cluster is suppressed only if its lead (most specific) signature belongs to a tombstone, so a
 * generic alias shared with an old event ("Night Show") cannot hide a different one ("Music Night Show").
 * If the tombstone table overflows, new estimated events are not published for a few days (fail closed).
 */
export function resolveProviderEvents({
  items = [],
  dlhdEvents = [],
  previousRegistry = {},
  now = Date.now(),
  leadMinutes = 240,
  tailMinutes = 60,
  maxEvents = 150,
  failedSourceIds = [],
} = {}) {
  const rows = [];
  const refs = [];
  const failed = new Set(failedSourceIds);
  const status = {
    candidateRows: items.length,
    clusters: 0,
    attachedToDlhd: 0,
    created: 0,
    expired: 0,
    suppressed: 0,
    notYetActive: 0,
    estimatedTimes: 0,
    capped: 0,
    unremembered: 0,
    overflowSuppressed: 0,
    mappings: 0,
  };

  const dlhdSignatures = dlhdEvents.map((ref) => ({
    ref,
    signature: eventSignature(ref.name, qualifierOf(ref.name)),
  }));

  // 1. Cluster, then attach clusters that DLHD already lists.
  const fresh = [];
  for (const cluster of clusterProviderEvents(items)) {
    status.clusters += 1;
    const attached = dlhdSignatures.find((candidate) =>
      signaturesMatch(candidate.signature, cluster.signature) && startsCompatible(candidate.ref.start ?? null, cluster.start));
    if (attached) {
      status.attachedToDlhd += 1;
      for (const item of cluster.items) rows.push({ source: item.source, row: item.row, reference: attached.ref, matchReason: "provider-event-dlhd" });
      continue;
    }
    const dated = cluster.items.some((x) => x.parsed.timeSource === "title-timestamp" || x.parsed.timeSource === "title-date");
    cluster.dated = dated;
    cluster.clockOnly = !dated && cluster.start != null;
    const sourceIds = [...new Set(cluster.items.map((item) => item.source?.id).filter(Boolean))];
    // Every contributing source is remembered; if there are too many to track, null means
    // "unknown", which later failure handling treats conservatively.
    cluster.sources = sourceIds.length <= MAX_TRACKED_SOURCES ? sourceIds : null;
    cluster.leadKey = tombstoneKey(cluster.signature);
    cluster.memberKeys = [...cluster.sigs.values()].map(tombstoneKey);
    fresh.push(cluster);
  }

  // 2. Reconcile with remembered identities (best start-time match, each identity once).
  const assigned = assignPreviousIdentities(fresh, previousRegistry);
  const meta = previousRegistry?.[META_KEY] && typeof previousRegistry[META_KEY] === "object" ? previousRegistry[META_KEY] : {};
  const previousTombs = meta.tombs && typeof meta.tombs === "object" ? meta.tombs : {};
  const tombIndex = new Map();
  for (const [key, tomb] of Object.entries(previousTombs)) {
    tombIndex.set(key, key);
    for (const member of Array.isArray(tomb?.m) ? tomb.m : []) if (!tombIndex.has(member)) tombIndex.set(member, key);
  }
  const overflowAt = Number(meta.overflowAt);
  const inOverflow = Number.isFinite(overflowAt) && overflowAt > 0 && now - overflowAt < REGISTRY_MAX_AGE_MS;

  // Absence is only confirmed by a refresh in which none of the sources that carried the listing failed.
  const unconfirmed = (sources) => failed.size > 0 && (!Array.isArray(sources) || sources.some((id) => failed.has(id)));
  const confirmedGone = (goneAt, lastSeen) => Number.isFinite(Number(goneAt)) && now - Number(lastSeen || 0) > REAPPEAR_GAP_MS;

  const usedIds = new Set(Object.keys(previousRegistry || {}));
  const mint = (base) => {
    let id = base;
    for (let n = 1; usedIds.has(id); n++) id = `${base}-${hash(`${base}|${n}`, 4)}`;
    return id;
  };

  const tombs = {};
  const touchedTombs = new Set();
  const planned = [];
  fresh.forEach((cluster, clusterIndex) => {
    const lead = displayTitle(cluster);
    const category = categoryFor(lead.group);
    const previous = assigned.get(clusterIndex) || null;
    const continuing = Boolean(previous) && !confirmedGone(previous.entry.goneAt, previous.entry.lastSeen);

    let start = cluster.start;
    let timeSource = start == null ? null : (cluster.items.find((x) => x.parsed.start != null)?.parsed.timeSource || "title-timestamp");
    let firstSeen = continuing ? Number(previous.entry.firstSeen) || now : now;
    let previousStart = continuing && Number.isFinite(Number(previous.entry.start)) ? Number(previous.entry.start) : null;
    if (cluster.clockOnly && previousStart != null) {
      // "10am" with no date: keep the day it was first resolved to instead of
      // re-deriving "the nearest 10am" on every refresh (which drifts across midnight).
      start = previousStart;
    }
    const estimated = start == null;
    const needsMemory = estimated || cluster.clockOnly;

    let tombKey = null;
    let suppressed = false;
    let overflowSuppressed = false;
    if (needsMemory && !previous) {
      tombKey = tombIndex.get(cluster.leadKey) || null;
      const tomb = tombKey ? previousTombs[tombKey] : null;
      if (tomb && confirmedGone(tomb.g, tomb.t)) {
        tombKey = null; // confirmed gone for long enough: this is a new occurrence
      } else if (tomb) {
        touchedTombs.add(tombKey);
        if (tomb.u && Number.isFinite(Number(tomb.f))) {
          // Left out earlier only because the registry was full: admit it now, keeping its original first-seen time.
          firstSeen = Number(tomb.f);
          previousStart = firstSeen;
        } else suppressed = true;
      } else if (estimated && inOverflow) {
        overflowSuppressed = true;
      }
    }
    if (estimated) {
      // No row carries a time and DLHD does not list the event: treat it as
      // starting when it first appeared in the provider playlist.
      start = previousStart ?? firstSeen;
      timeSource = "first-seen";
      if (!suppressed && !overflowSuppressed) status.estimatedTimes += 1;
    }
    const end = start + eventDurationMinutes(category, lead.title) * MINUTE;
    const expired = suppressed || overflowSuppressed || now > end + tailMinutes * MINUTE;
    const notYet = !expired && now < start - leadMinutes * MINUTE;

    let id = previous?.id;
    if (!id && !suppressed && !overflowSuppressed) {
      const core = cluster.core?.size ? [...cluster.core] : signatureTokens(cluster.signature);
      const sigKey = normalize(`${core.sort().join(" ")}|${cluster.signature.qualifier}`);
      // Hour precision: the same title at 08:00 and 18:00 are different occurrences.
      const when = cluster.dated ? new Date(cluster.start).toISOString().slice(0, 13) : "";
      id = mint(`pevent-${slug(lead.title).slice(0, 48)}-${hash(`${sigKey}|${when}`, 8)}`);
      usedIds.add(id);
    }

    if (suppressed) {
      // Refresh the matched tombstone only; a suppressed cluster never adds tombstones of its own.
      const tomb = previousTombs[tombKey];
      tombs[tombKey] = { ...tomb, t: now, g: undefined, s: unionSources(tomb.s, cluster.sources) };
    } else if (needsMemory && expired) {
      tombs[cluster.leadKey] = { t: now, s: cluster.sources, m: cluster.memberKeys };
    }
    planned.push({
      cluster, lead, category, id, start, end, timeSource, estimated, expired, notYet, suppressed, overflowSuppressed,
      known: Boolean(previous),
      needsMemory,
      firstSeen,
      entry: { firstSeen, lastSeen: now, start, clock: cluster.clockOnly === true, sources: cluster.sources, sig: serializeSignature(cluster.signature) },
    });
  });

  // 3. Decide what the (bounded) registry remembers: active events only. An event
  // whose time is only an estimate must be remembered or it would look brand new on
  // every refresh, so when the registry is full an estimated event that does not fit
  // is held back (as an "unadmitted" tombstone that keeps its first-seen time and can
  // be admitted once there is room). Expired events live in tombstones and never take these slots.
  const wantsEntry = (p) => p.id && !(p.needsMemory && p.expired) && (p.needsMemory || (!p.expired && !p.notYet));
  const keepOrder = planned.filter(wantsEntry).sort((a, b) =>
    (b.known - a.known) || (b.needsMemory - a.needsMemory) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const registry = {};
  for (const plan of keepOrder.slice(0, REGISTRY_MAX_ENTRIES)) registry[plan.id] = plan.entry;
  for (const plan of planned) {
    if (plan.needsMemory && !plan.expired && plan.id && !registry[plan.id]) {
      tombs[plan.cluster.leadKey] = { u: 1, f: plan.firstSeen, t: now, s: plan.cluster.sources, m: plan.cluster.memberKeys };
    }
  }

  // Entries and tombstones nothing matched this refresh were absent from the scans. That only
  // counts as "gone" if every source that carried them succeeded; it is recorded, never inferred later.
  const consumed = new Set(planned.filter((plan) => plan.known).map((plan) => plan.id));
  for (const [id, entry] of Object.entries(previousRegistry || {})) {
    if (id === META_KEY || registry[id] || consumed.has(id)) continue;
    if (Object.keys(registry).length >= REGISTRY_MAX_ENTRIES) break;
    if (now - Number(entry?.lastSeen || 0) >= REGISTRY_MAX_AGE_MS) continue;
    const goneAt = Number.isFinite(Number(entry.goneAt)) ? Number(entry.goneAt) : (unconfirmed(entry.sources) ? undefined : now);
    registry[id] = { ...entry, goneAt };
  }
  for (const [key, tomb] of Object.entries(previousTombs)) {
    if (tombs[key] || touchedTombs.has(key)) continue;
    if (now - Number(tomb?.t || 0) >= REGISTRY_MAX_AGE_MS) continue;
    const g = Number.isFinite(Number(tomb.g)) ? Number(tomb.g) : (unconfirmed(tomb.s) ? undefined : now);
    tombs[key] = { ...tomb, g };
  }
  const tombEntries = Object.entries(tombs).sort((a, b) => Number(b[1].t) - Number(a[1].t) || (a[0] < b[0] ? -1 : 1));
  const kept = tombEntries.slice(0, TOMBSTONE_MAX_ENTRIES);
  registry[META_KEY] = {
    lastRun: now,
    tombs: Object.fromEntries(kept),
    // Evicted tombstones can no longer suppress their events, so while that is possible new
    // estimated events are not published (fail closed) rather than risk resurrecting them.
    ...(tombEntries.length > kept.length ? { overflowAt: now } : inOverflow ? { overflowAt } : {}),
  };

  // 4. Publish.
  const built = [];
  for (const plan of planned) {
    if (plan.suppressed) { status.suppressed += 1; continue; }
    if (plan.overflowSuppressed) { status.overflowSuppressed += 1; continue; }
    if (plan.needsMemory && !plan.expired && !registry[plan.id]) { status.unremembered += 1; continue; }
    if (plan.expired) { status.expired += 1; continue; }
    if (plan.notYet) { status.notYetActive += 1; continue; }
    const { cluster, lead, category, id } = plan;
    const name = lead.competition ? `${lead.competition}: ${lead.title}` : lead.title;
    const aliases = [...new Set([lead.title, ...cluster.items.map((x) => x.parsed.title)])];
    const ref = {
      kind: "event",
      source: "provider",
      id,
      key: normalize(`event|${id}`),
      tvgId: `justone.pevent.${id.replace(/^pevent-/, "")}`,
      dlhdId: "",
      name,
      logo: "",
      aliases,
      group: `Events | ${category}`,
      linkedChannels: [],
      linkedStaticChannels: [],
      start: plan.start,
      end: plan.end,
      time: clockLabel(plan.start),
      category,
      upcoming: plan.start > now,
      timeSource: plan.timeSource,
      timeEstimated: plan.estimated,
    };
    built.push({
      ref,
      rows: cluster.items.map((item) => ({ source: item.source, row: item.row, reference: ref, matchReason: "provider-event" })),
    });
  }

  // Safety cap: keep the events carried by the most slots (the big ones), then the
  // ones closest to now, so a very large provider list cannot flood the lineup.
  built.sort((a, b) => b.rows.length - a.rows.length || Math.abs(a.ref.start - now) - Math.abs(b.ref.start - now) || (a.ref.id < b.ref.id ? -1 : 1));
  for (const entry of built.slice(0, maxEvents)) {
    refs.push(entry.ref);
    rows.push(...entry.rows);
  }
  status.capped = Math.max(0, built.length - maxEvents);
  status.created = refs.length;
  status.mappings = rows.length;
  return { rows, refs, registry, status };
}
