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
  const folder = `${clean} (${year}) ${id}`;
  // Keep the STRM useful even if it is viewed/copied outside its parent folder.
  // Do not invent release/source/codec tags: a resolver-backed file does not know
  // those until playback time.
  return { folder, file: `${clean} (${year}) ${id}.strm` };
}

export function seriesFolder(title, year, { tvdbId, tmdbId } = {}) {
  const base = `${cleanTitleWithoutYear(title, year)} (${year})`;
  if (tvdbId) return `${base} [tvdbid-${tvdbId}]`;
  if (tmdbId) return `${base} [tmdbid-${tmdbId}]`;
  return base;
}

export function episodeFile(seriesTitle, year, season, episode, episodeTitle, tmdbId = null) {
  const show = cleanTitleWithoutYear(seriesTitle, year);
  const code = `S${pad(season)}E${pad(episode)}`;
  const cleanedEpisode = cleanTitle(episodeTitle).slice(0, 90).trim();
  const ep = cleanedEpisode ? ` - ${cleanedEpisode}` : "";
  const id = tmdbId ? ` [tmdbid-${tmdbId}]` : "";
  return `${show} (${year}) - ${code}${ep}${id}.strm`;
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
