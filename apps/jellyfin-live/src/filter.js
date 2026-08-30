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

function normalizeGroupPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isVodStyleChannel(ch) {
  const parts = String(ch?.group || "")
    .split(/[|/]/)
    .map(normalizeGroupPart)
    .filter(Boolean);
  return parts.some((part) => VOD_GROUPS.has(part));
}

export function filterJellyfinRows(rows) {
  return (rows || []).filter((ch) => !isVodStyleChannel(ch));
}
