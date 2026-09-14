import { strippedChannelName } from "./identity.js";
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
    if (EVENT_LIKE_RE.test(inner) || /\d{4}-\d{2}-\d{2}/.test(inner) || /\b(?:cricket|hockey|football|soccer|basketball|baseball|wrestling|mma|boxing|tennis|golf)\b/i.test(inner)) {
      return inner;
    }
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

function keyVariants(value) {
  let base = normalize(strippedChannelName(cleanEventDecorations(value)));
  if (!base) return [];
  let tokens = base.split(" ").filter(Boolean);
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  tokens = tokens.map(canonicalToken);
  if (!tokens.length) return [];

  const out = new Set();
  const add = (parts) => {
    if (!parts.length) return;
    const joined = parts.join(" ");
    out.add(joined);
    out.add(joined.replace(/\s+/g, ""));
    if (joined.endsWith(" tv")) out.add(joined.slice(0, -3).trim());
  };

  add(tokens);
  const withoutRegion = tokens.filter((token) => !REGION_TOKENS.has(token));
  if (withoutRegion.length !== tokens.length) add(withoutRegion);
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
  const score = 0.72 * shortCoverage + 0.28 * refCoverage;
  return { score, common, shortCoverage, refCoverage };
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

  for (const ref of reference?.channels || []) {
    addIndex(staticIndex, [ref.name, ...(ref.aliases || [])], ref);
  }
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
    const rawNames = [row?.tvgName, row?.name].filter(Boolean);
    const aliasName = aliases[normalize(strippedChannelName(rawNames[0] || ""))];
    if (aliasName) rawNames.push(aliasName);
    return rawNames;
  }

  function match(row) {
    const rawNames = namesFor(row);
    const matches = new Map();
    for (const value of rawNames) {
      for (const key of keyVariants(value)) {
        for (const ref of staticIndex.get(key) || []) matches.set(ref.id, ref);
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
