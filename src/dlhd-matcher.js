import { strippedChannelName } from "./identity.js";
import { normalize } from "./util.js";

const COUNTRY_WORDS = new Set([
  "uk","gb","usa","us","united","kingdom","states","portugal","pt","spain","es","france","fr","germany","de",
  "italy","it","canada","ca","australia","au","romania","poland","sweden","norway","denmark","finland","ireland",
  "netherlands","nl","belgium","ch","switzerland","austria","greece","turkey","serbia","croatia","israel","mexico",
  "brazil","argentina","new","zealand","nz","india","japan","korea","china","russia","bulgaria","slovakia","cz"
]);
const BORING_TOKENS = new Set(["live","channel","sports","sport","tv","hd","fhd","uhd","sd","vs","versus"]);
const EVENT_LIKE_RE = /(?:\bvs\.?\b|\bv\b|@|\bppv\b|\bevent\b|\b(?:final|semifinal|semi-final|quarterfinal|quarter-final|qualifying|practice|race|round|stage|session)\b)/i;

function keyVariants(value) {
  let base = normalize(strippedChannelName(value));
  if (!base) return [];
  let tokens = base.split(" ").filter(Boolean);
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && COUNTRY_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  base = tokens.join(" ");
  const out = new Set([base, base.replace(/\s+/g, "")]);
  if (base.endsWith(" tv")) out.add(base.slice(0, -3).trim());
  return [...out].filter(Boolean);
}

function significantTokens(value) {
  const first = keyVariants(value)[0] || "";
  return new Set(first.split(" ").filter((x) => x.length > 1 && !COUNTRY_WORDS.has(x) && !BORING_TOKENS.has(x)));
}

function fuzzyTokenMatch(a, b) {
  if (a.size < 2 || b.size < 2) return false;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  // Two-team fixtures commonly reduce to only two useful tokens once league,
  // country, quality and "v/vs" decorations are removed. Requiring three
  // tokens caused valid provider event names such as "Arsenal v Chelsea" to
  // miss a DLHD event titled "Premier League: Arsenal vs Chelsea".
  return common >= 2 && common / Math.min(a.size, b.size) >= 0.8;
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

export function createDlhdMatcher(reference, aliases = {}) {
  const staticIndex = new Map();
  const eventTitleIndex = new Map();
  const eventAliasIndex = new Map();
  const fuzzyEvents = [];

  for (const ref of reference?.channels || []) {
    addIndex(staticIndex, [ref.name, ...(ref.aliases || [])], ref);
  }
  for (const ref of reference?.events || []) {
    addIndex(eventTitleIndex, [ref.name], ref);
    addIndex(eventAliasIndex, (ref.aliases || []).slice(1), ref);
    fuzzyEvents.push({ ref, tokens: significantTokens(ref.name) });
  }

  function match(row) {
    const rawNames = [row?.tvgName, row?.name].filter(Boolean);
    const aliasName = aliases[normalize(strippedChannelName(rawNames[0] || ""))];
    if (aliasName) rawNames.push(aliasName);

    const matches = new Map();
    for (const value of rawNames) {
      for (const key of keyVariants(value)) {
        for (const ref of staticIndex.get(key) || []) matches.set(ref.id, ref);
        for (const ref of eventTitleIndex.get(key) || []) matches.set(ref.id, ref);
        for (const ref of eventAliasIndex.get(key) || []) matches.set(ref.id, ref);
      }
    }

    const hasEvent = [...matches.values()].some((ref) => ref.kind === "event");
    if (!hasEvent && rawNames.some((value) => EVENT_LIKE_RE.test(String(value)))) {
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

  return {
    match,
    staticCount: reference?.channels?.length || 0,
    eventCount: reference?.events?.length || 0,
  };
}
