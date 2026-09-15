import { countryOf, strippedChannelName } from "./identity.js";
import { normalize } from "./util.js";

const COUNTRY_WORDS = new Set([
  "uk","gb","usa","us","united","kingdom","states","portugal","pt","spain","es","france","fr","germany","de",
  "italy","it","canada","ca","australia","au","romania","poland","sweden","norway","denmark","finland","ireland",
  "netherlands","nl","belgium","ch","switzerland","austria","greece","turkey","serbia","croatia","israel","mexico",
  "brazil","argentina","new","zealand","nz","india","japan","korea","china","russia","bulgaria","slovakia","cz",
  "england","scotland","wales"
]);
const NUMBER_WORDS = new Map([
  ["one","1"],["two","2"],["three","3"],["four","4"],["five","5"],
  ["six","6"],["seven","7"],["eight","8"],["nine","9"],["ten","10"],
]);
const REGION_TOKENS = new Set(["east","west"]);
const BORING_TOKENS = new Set([
  "live","channel","sports","sport","tv","hd","fhd","uhd","sd","vs","versus","event","events","only","feed","stream",
  "start","stop"
]);
const EVENT_LIKE_RE = /(?:\bvs\.?\b|\bv\b|\bx\b|@|\bppv\b|\bevents?\b|\b(?:final|semifinal|semi-final|quarterfinal|quarter-final|qualifying|practice|race|round|stage|session)\b)/i;
const EVENT_GROUP_RE = /(?:\blive\s*events?\b|\bppv\b|\bespn\s*plus\b|\bdazn\b|\bflo\b|\bfanatiz\b|\bmax\s*ppv\b|\bncaa\b|\bnfl\b|\bnba\b|\bnhl\b|\bmlb\b|\bmls\b)/i;
const DECORATION_BRACKET_RE = /^(?:event\s*only|ppv|live|bk|backup|alt|hd|fhd|uhd|sd|km|bg)$/i;

// Deliberate brand/callsign equivalents only. These add exact lookup keys and
// never loosen fuzzy matching. Static matches are also country-checked below,
// which makes aliases such as DAZN 1 <-> Eleven Sports 1 safe across GB/PT.
const STATIC_ALIAS_GROUPS = [
  ["bbc four", "bbc 4"],
  ["benfica tv", "btv", "benfica tv 1", "btv 1"],
  ["tnt sports 1", "tnt sport 1", "tnt sports 01", "tnt sport 01", "bt sport 1", "bt sports 1"],
  ["tnt sports 2", "tnt sport 2", "tnt sports 02", "tnt sport 02", "bt sport 2", "bt sports 2"],
  ["tnt sports 3", "tnt sport 3", "tnt sports 03", "tnt sport 03", "bt sport 3", "bt sports 3"],
  ["tnt sports 4", "tnt sport 4", "tnt sports 04", "tnt sport 04", "bt sport 4", "bt sports 4"],
  ["viaplay sports 1", "premier sports 1"],
  ["viaplay sports 2", "premier sports 2"],
  ["big ten network", "big 10 network", "big ten network btn", "big 10 network btn", "btn"],
  ["abc ny", "wabc", "abc 7 ny", "abc 7 new york", "wabc 7"],
  ["cbsny", "cbs ny", "wcbs", "cbs 2 ny", "cbs 2 new york", "wcbs 2"],
  ["nbcny", "nbc ny", "wnbc", "nbc 4 ny", "nbc 4 new york", "wnbc 4"],
  ["foxny", "fox ny", "wnyw", "fox 5 ny", "fox 5 new york", "wnyw 5"],
  ["cw pix 11", "pix 11", "pix11", "wpix", "wpix 11"],
  ["my9tv", "my 9", "my9", "wwor", "wwor 9"],
  ["fox", "fox network", "fox east", "fox national"],
  ["cw", "cw network", "the cw"],
  ["cbs", "cbs network"],
  ["crime investigation", "crime plus investigation", "crime and investigation", "crime investigation network", "c i", "ci"],
  ["mgm", "mgm usa epix", "mgm plus", "mgm plus usa epix", "epix"],
  ["showtime 2", "showtime 2 sho2", "sho2"],
  ["showtime family zone", "showtime family zone sho family zone", "sho family zone"],
  ["showtime next", "showtime next sho next", "sho next"],
  ["tmc channel", "the movie channel", "tmc"],
  ["heroes and icons", "heroes and icons h and i", "h and i"],
  ["investigation discovery", "investigation discovery id", "discovery id", "id network", "id"],
  ["racer tv", "racer network", "mavtv", "mav tv"],
  ["sky sports action", "sky sports nfl"],
  ["spectrum sportsnet", "spectrum sports net"],
  ["sky cinema select", "sky select"],
  ["sky cinema animation", "sky animation"],
  ["sky cinema sci fi horror", "sky cinema sci fi and horror", "sky cinema sci fi & horror", "sky sci fi horror", "sky scifi horror"],
  ["tudn", "tudn network"],
  ["tvi reality", "tvi reality 24 7", "tvi reality 24/7"],
  ["eleven sports 1", "dazn eleven 1", "dazn 1", "dazn 01"],
  ["eleven sports 2", "dazn eleven 2", "dazn 2", "dazn 02"],
  ["eleven sports 3", "dazn eleven 3", "dazn 3", "dazn 03"],
  ["eleven sports 4", "dazn eleven 4", "dazn 4", "dazn 04"],
  ["eleven sports 5", "dazn eleven 5", "dazn 5", "dazn 05"],
];

const STATIC_ALIAS_INDEX = (() => {
  const index = new Map();
  for (const group of STATIC_ALIAS_GROUPS) {
    const values = [...new Set(group.map((value) => normalize(value)).filter(Boolean))];
    for (const value of values) index.set(value, values);
  }
  return index;
})();

function expandLeagueAliases(value) {
  return String(value || "")
    .replace(/\bEPL\b/gi, "Premier League")
    .replace(/\bUCL\b/gi, "Champions League")
    .replace(/\bUEL\b/gi, "Europa League")
    .replace(/\bUECL\b/gi, "Conference League")
    .replace(/\bL1\b/gi, "League One")
    .replace(/\bL2\b/gi, "League Two")
    .replace(/\bSPL\b/gi, "Scottish Premiership")
    .replace(/\bWSL\b/gi, "Women Super League");
}

function meaningfulBracket(value) {
  const source = String(value || "");
  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const inner = String(match[1] || "").trim();
    if (!inner || DECORATION_BRACKET_RE.test(inner)) continue;
    if (EVENT_LIKE_RE.test(inner) || /\d{4}-\d{2}-\d{2}/.test(inner) || /\b(?:cricket|hockey|football|soccer|basketball|baseball|wrestling|mma|boxing|tennis|golf)\b/i.test(inner)) return inner;
  }
  return "";
}

function cleanEventDecorations(value) {
  const bracket = meaningfulBracket(value);
  let source = bracket || String(value || "");
  source = source
    .replace(/\b([A-Za-z][A-Za-z0-9 .'-]{1,40})\s+x\s+([A-Za-z][A-Za-z0-9 .'-]{1,40})\b/gi, "$1 vs $2")
    .replace(/\b(?:start|stop)\s*:\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/gi, " ")
    .replace(/\(\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*\)/g, " ")
    .replace(/\[(?:event\s*only|ppv|live|bk|backup|alt|hd|fhd|uhd|sd)\]/gi, " ")
    .replace(/\b(?:live\s+football|live\s+soccer|event|ppv|mlb\s+live|nhl\s+live|nba\s+live)\s*\d{1,3}\s*[:|-]?/gi, " ")
    .replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, " ");
  return expandLeagueAliases(source);
}

function canonicalToken(token) {
  if (NUMBER_WORDS.has(token)) return NUMBER_WORDS.get(token);
  if (token === "events") return "event";
  if (token === "channels") return "channel";
  return token;
}

function normalizedBase(value) {
  let base = normalize(strippedChannelName(cleanEventDecorations(value)));
  base = base
    .replace(/\bgalavisi n\b/g, "galavision")
    .replace(/\bgalavisi o n\b/g, "galavision");
  if (!base) return "";
  let tokens = base.split(" ").filter(Boolean);
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.map(canonicalToken).join(" ");
}

function keyVariants(value) {
  const base = normalizedBase(value);
  if (!base) return [];
  const bases = new Set([base]);
  for (const alias of STATIC_ALIAS_INDEX.get(base) || []) bases.add(alias);

  const knownCorePatterns = [
    [/^mgm(?: plus)? .* epix$/, "mgm"],
    [/^showtime 2 .* sho2.*$/, "showtime 2"],
    [/^showtime family zone .* sho family zone.*$/, "showtime family zone"],
    [/^showtime next .* sho next.*$/, "showtime next"],
    [/^big (?:ten|10) network .* btn.*$/, "big 10 network"],
    [/^heroes and icons .* h and i.*$/, "heroes and icons"],
    [/^investigation discovery .* id.*$/, "investigation discovery"],
  ];
  for (const [re, replacement] of knownCorePatterns) {
    if (!re.test(base)) continue;
    bases.add(replacement);
    for (const alias of STATIC_ALIAS_INDEX.get(replacement) || []) bases.add(alias);
  }

  const out = new Set();
  const add = (parts) => {
    if (!parts.length) return;
    const joined = parts.join(" ");
    out.add(joined);
    out.add(joined.replace(/\s+/g, ""));
    if (joined.endsWith(" tv")) out.add(joined.slice(0, -3).trim());
  };
  for (const candidate of bases) {
    const tokens = candidate.split(" ").filter(Boolean).map(canonicalToken);
    add(tokens);
    const withoutRegion = tokens.filter((token) => !REGION_TOKENS.has(token));
    if (withoutRegion.length !== tokens.length) add(withoutRegion);
  }
  return [...out].filter(Boolean);
}

function significantTokens(value) {
  const first = keyVariants(value)[0] || "";
  return new Set(first.split(" ").filter((x) => x.length > 1 && !COUNTRY_WORDS.has(x) && !BORING_TOKENS.has(x) && !/^\d+$/.test(x)));
}

function tokenScore(a, b) {
  if (!a.size || !b.size) return { score: 0, common: 0, shortCoverage: 0, refCoverage: 0 };
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  const shortCoverage = common / Math.min(a.size, b.size);
  const refCoverage = common / b.size;
  return { score: 0.72 * shortCoverage + 0.28 * refCoverage, common, shortCoverage, refCoverage };
}

function fuzzyTokenMatch(a, b) {
  const result = tokenScore(a, b);
  if (Math.min(a.size, b.size) < 2) return false;
  return result.common >= 2 && result.shortCoverage >= 0.8;
}

function addIndex(map, values, row) {
  for (const value of values) {
    for (const key of keyVariants(value)) {
      const rows = map.get(key) || [];
      if (!rows.some((x) => x.id === row.id)) rows.push(row);
      map.set(key, rows);
    }
  }
}

function staticCountryCompatible(row, ref) {
  const rowCountry = countryOf(row);
  const refCountry = countryOf({ name: ref?.name || "", group: ref?.group || "" });
  return !rowCountry || !refCountry || rowCountry === refCountry;
}

export function isEventLikeRow(row) {
  const value = `${row?.group || ""} ${row?.tvgName || ""} ${row?.name || ""}`;
  return EVENT_GROUP_RE.test(value) || EVENT_LIKE_RE.test(value) || Boolean(meaningfulBracket(value));
}

export function createDlhdMatcher(reference, aliases = {}) {
  const staticIndex = new Map();
  const eventTitleIndex = new Map();
  const eventAliasIndex = new Map();
  const fuzzyEvents = [];
  const tokenIndex = new Map();
  const refTokens = new Map();
  const refs = [...(reference?.channels || []), ...(reference?.events || [])];

  for (const ref of reference?.channels || []) addIndex(staticIndex, [ref.name, ...(ref.aliases || [])], ref);
  for (const ref of reference?.events || []) {
    addIndex(eventTitleIndex, [ref.name], ref);
    addIndex(eventAliasIndex, (ref.aliases || []).slice(1), ref);
    fuzzyEvents.push({ ref, tokens: significantTokens(ref.name) });
  }
  for (const ref of refs) {
    const tokens = significantTokens(ref.name);
    refTokens.set(ref.id, tokens);
    for (const token of tokens) {
      const rows = tokenIndex.get(token) || [];
      if (!rows.some((x) => x.id === ref.id)) rows.push(ref);
      tokenIndex.set(token, rows);
    }
  }

  function namesFor(row) {
    // tvg-id is often the cleanest identifier in giant provider lists even when
    // the visible channel name has provider prefixes, stale branding or noise.
    // It still goes through exact-key aliases and static country checks; adding
    // it here does not make fuzzy static matching more permissive.
    const rawNames = [row?.tvgName, row?.name, row?.tvgId].filter(Boolean);
    const aliasName = aliases[normalize(strippedChannelName(rawNames[0] || ""))];
    if (aliasName) rawNames.push(aliasName);
    return [...new Set(rawNames)];
  }

  function match(row) {
    const rawNames = namesFor(row);
    const matches = new Map();
    for (const value of rawNames) {
      for (const key of keyVariants(value)) {
        for (const ref of staticIndex.get(key) || []) {
          if (staticCountryCompatible(row, ref)) matches.set(ref.id, ref);
        }
        // Event aliases intentionally do not country-filter because one event
        // may legitimately be carried by a channel from any territory.
        for (const ref of eventTitleIndex.get(key) || []) matches.set(ref.id, ref);
        for (const ref of eventAliasIndex.get(key) || []) matches.set(ref.id, ref);
      }
    }

    const hasEvent = [...matches.values()].some((ref) => ref.kind === "event");
    if (!hasEvent && isEventLikeRow(row)) {
      for (const value of rawNames) {
        const tokens = significantTokens(value);
        if (tokens.size < 2) continue;
        for (const candidate of fuzzyEvents) {
          if (fuzzyTokenMatch(tokens, candidate.tokens)) matches.set(candidate.ref.id, candidate.ref);
        }
      }
    }
    return [...matches.values()];
  }

  function suggest(row, { kind = null, limit = 5, minScore = 0.34 } = {}) {
    const rawNames = namesFor(row);
    const byRef = new Map();
    for (const value of rawNames) {
      const tokens = significantTokens(value);
      if (!tokens.size) continue;
      const candidates = new Map();
      for (const token of tokens) {
        for (const ref of tokenIndex.get(token) || []) {
          if (kind && ref.kind !== kind) continue;
          if (ref.kind === "channel" && !staticCountryCompatible(row, ref)) continue;
          candidates.set(ref.id, ref);
        }
      }
      for (const ref of candidates.values()) {
        const scoreData = tokenScore(tokens, refTokens.get(ref.id) || new Set());
        if (scoreData.score < minScore || scoreData.common < 1) continue;
        const previous = byRef.get(ref.id);
        if (!previous || scoreData.score > previous.score) {
          byRef.set(ref.id, {
            ref,
            score: Number(scoreData.score.toFixed(3)),
            commonTokens: scoreData.common,
            candidateName: String(row?.tvgName || row?.name || ""),
            providerName: String(row?.name || row?.tvgName || ""),
            group: String(row?.group || ""),
          });
        }
      }
    }
    return [...byRef.values()]
      .sort((a, b) => b.score - a.score || b.commonTokens - a.commonTokens || a.ref.name.localeCompare(b.ref.name))
      .slice(0, limit);
  }

  return {
    match,
    suggest,
    staticCount: reference?.channels?.length || 0,
    eventCount: reference?.events?.length || 0,
  };
}
