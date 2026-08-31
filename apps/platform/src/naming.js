export const MAX_NAME_BYTES = 240;

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;

  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out.replace(/[. ]+$/g, "");
}

function fitComponent(prefix, suffix = "") {
  const tail = String(suffix || "");
  const budget = Math.max(0, MAX_NAME_BYTES - utf8Bytes(tail));
  return `${truncateUtf8(prefix, budget)}${tail}`;
}

export function cleanTitle(name) {
  return String(name || "")
    .replace(/:/g, " -")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

function cleanTitleWithoutYear(name, year) {
  let out = cleanTitle(name);
  const y = String(year || "").trim();
  if (/^\d{4}$/.test(y)) {
    out = out
      .replace(new RegExp(`\\s*\\(${y}\\)\\s*$`), "")
      .replace(new RegExp(`\\s+${y}\\s*$`), "")
      .trim();
  }
  return out;
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

export function movieFolder(title, year, tmdbId) {
  const clean = cleanTitleWithoutYear(title, year);
  const id = `[tmdbid-${tmdbId}]`;
  const folder = fitComponent(clean, ` (${year}) ${id}`);
  // Keep the STRM useful even if it is viewed/copied outside its parent folder.
  // Do not invent release/source/codec tags: a resolver-backed file does not know
  // those until playback time.
  return { folder, file: fitComponent(clean, ` (${year}) ${id}.strm`) };
}

export function seriesFolder(title, year, { tvdbId, tmdbId } = {}) {
  const clean = cleanTitleWithoutYear(title, year);
  const id = tvdbId ? `[tvdbid-${tvdbId}]` : tmdbId ? `[tmdbid-${tmdbId}]` : "";
  const suffix = ` (${year})${id ? ` ${id}` : ""}`;
  return fitComponent(clean, suffix);
}

export function episodeFile(seriesTitle, year, season, episode, episodeTitle, tmdbId = null) {
  const show = cleanTitleWithoutYear(seriesTitle, year);
  const code = `S${pad(season)}E${pad(episode)}`;
  const cleanedEpisode = cleanTitle(episodeTitle).slice(0, 90).trim();
  const id = tmdbId ? ` [tmdbid-${tmdbId}]` : "";
  const fixedAfterShow = ` (${year}) - ${code}`;
  const tail = `${id}.strm`;

  // Preserve the season/episode code and identity suffix even for pathological
  // metadata. Linux filesystems normally cap a single name component at 255
  // bytes, so leave some headroom and trim on UTF-8 byte boundaries.
  const showBudget = Math.max(
    0,
    MAX_NAME_BYTES - utf8Bytes(fixedAfterShow) - utf8Bytes(tail),
  );
  const safeShow = truncateUtf8(show, showBudget);
  const base = `${safeShow}${fixedAfterShow}`;
  const remaining = Math.max(0, MAX_NAME_BYTES - utf8Bytes(base) - utf8Bytes(tail));

  let ep = "";
  if (cleanedEpisode && remaining > utf8Bytes(" - ")) {
    const safeEpisode = truncateUtf8(cleanedEpisode, remaining - utf8Bytes(" - "));
    if (safeEpisode) ep = ` - ${safeEpisode}`;
  }

  return `${base}${ep}${tail}`;
}

export function downloadName(strmFile, ext = "mp4") {
  return String(strmFile).replace(/\.strm$/i, `.${ext}`);
}

export function libraryRoot(kind, quality) {
  const q = quality === "4k" ? "4k" : "1080p";
  return kind === "movie" ? `movies-${q}` : `tv-${q}`;
}

export function slugTvgId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "")
    .slice(0, 48);
}
