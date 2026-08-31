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

// A provider can put genuine linear networks inside a generic "Movies" or
// "TV Shows" bucket. Preserve established broadcast networks while removing
// title/episode-style VOD rows from those buckets.
const LINEAR_MOVIE_OR_SHOW_CHANNEL_RE = /\b(?:axn(?:\s+movies?)?|fox\s+movies?|fx\s+movie\s+channel|fxx?|film4|sky\s+cinema(?:\s+[a-z0-9&+' -]+)?|sony\s+movies?|hallmark(?:\s+movies?\s*(?:&|and)\s*mysteries)?|lifetime\s+movies?\s+network|movies?\s*24|tcm|turner\s+classic\s+movies|amc|hbo(?:\s+[a-z0-9&+' -]+)?|cinemax(?:\s+[a-z0-9&+' -]+)?|starz(?:\s+[a-z0-9&+' -]+)?|paramount\s+network|star\s+movies?|cine(?:star|canal)|v\s+film(?:\s+[a-z0-9&+' -]+)?|yes\s+movies(?:\s+[a-z0-9&+' -]+)?)\b/i;

const ADULT_RE = /(?:^|[^a-z0-9])(?:18\+|adult|xxx|porn|playboy|brazzers|redlight|babestation)(?=$|[^a-z0-9])/i;
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

function isVodGroup(ch) {
  if (groupParts(ch).some((part) => VOD_GROUPS.has(part))) return true;

  // Also catch common combined labels such as "24/7 Movies" without treating
  // unrelated sports labels such as "World Series" as VOD.
  const whole = String(ch?.group || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:24\s*\/\s*7\s*)?(?:movies?|films?|tv\s*shows?|series|vod)$/.test(whole);
}

export function isLinearMovieOrShowChannel(ch) {
  return LINEAR_MOVIE_OR_SHOW_CHANNEL_RE.test(String(ch?.name || ch?.tvgName || ""));
}

export function isVodStyleChannel(ch) {
  return isVodGroup(ch) && !isLinearMovieOrShowChannel(ch);
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
