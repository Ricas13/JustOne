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

const ADULT_RE = /(?:^|[^a-z0-9])(?:18\+|adult|xxx|porn|playboy|brazzers|redlight|babestation)(?=$|[^a-z0-9])/i;

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

/**
 * Remove only content that is structurally VOD from the Live TV view.
 *
 * Adult filtering is intentionally owned by buildMetadataLineup(), where the
 * JELLYFIN_EXCLUDE_ADULT setting is available. Do not silently remove source
 * families such as free providers or IPTV-org here: they are valid Live TV
 * rows and metadata enrichment must not change source selection policy.
 */
export function filterJellyfinRows(rows) {
  return (rows || []).filter((ch) => !isVodStyleChannel(ch));
}
