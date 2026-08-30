const VOD_GROUPS = new Set([
  "movie",
  "movies",
  "film",
  "films",
  "tv show",
  "tv shows",
  "series",
  "vod",
]);

const FREE_GROUPS = new Set([
  "free channel",
  "free channels",
  "free tv",
  "free television",
  "free streams",
  "free iptv",
]);

const ADULT_RE = /(^|\b)(?:18\+|adult|xxx|porn|playboy|brazzers|redlight|babestation)(\b|$)/i;
const FREE_PROVIDER_RE = /\b(?:pluto\s*tv|samsung\s*tv\s*plus|plex\s*(?:live\s*)?tv|the\s+roku\s+channel|lg\s+channels|xumo(?:\s+play)?|tubi(?:\s+tv)?)\b/i;
const IPTV_ORG_RE = /\biptv[\s._-]*org\b/i;

function normalizeGroupPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupParts(ch) {
  return String(ch?.group || "")
    .split(/[|/]/)
    .map(normalizeGroupPart)
    .filter(Boolean);
}

export function isVodStyleChannel(ch) {
  return groupParts(ch).some((part) => VOD_GROUPS.has(part));
}

export function isAdultStyleChannel(ch) {
  return ADULT_RE.test(`${ch?.name || ""} ${ch?.group || ""} ${ch?.tvgId || ""}`);
}

export function isFreeStyleChannel(ch) {
  if (groupParts(ch).some((part) => FREE_GROUPS.has(part))) return true;
  const hay = `${ch?.name || ""} ${ch?.group || ""}`;
  return FREE_PROVIDER_RE.test(hay);
}

export function isIptvOrgStyleChannel(ch) {
  const hay = `${ch?.name || ""} ${ch?.group || ""} ${ch?.tvgId || ""}`;
  if (IPTV_ORG_RE.test(hay)) return true;
  try {
    const url = new URL(String(ch?.url || ""));
    return /(^|\.)iptv-org\.github\.io$/i.test(url.hostname)
      || (/raw\.githubusercontent\.com$/i.test(url.hostname) && /^\/iptv-org\//i.test(url.pathname));
  } catch {
    return false;
  }
}

export function filterJellyfinRows(rows) {
  return (rows || []).filter((ch) =>
    !isVodStyleChannel(ch)
    && !isAdultStyleChannel(ch)
    && !isFreeStyleChannel(ch)
    && !isIptvOrgStyleChannel(ch),
  );
}
