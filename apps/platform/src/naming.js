export function cleanTitle(name) {
  return String(name)
    .replace(/:/g, " -")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

export function movieFolder(title, year, tmdbId) {
  const base = `${cleanTitle(title)} (${year}) [tmdbid-${tmdbId}]`;
  return { folder: base, file: `${base}.strm` };
}

export function seriesFolder(title, year, { tvdbId, tmdbId }) {
  const id = tvdbId ? `[tvdbid-${tvdbId}]` : `[tmdbid-${tmdbId}]`;
  return `${cleanTitle(title)} (${year}) ${id}`;
}

export function episodeFile(seriesTitle, year, season, episode, episodeTitle) {
  const show = cleanTitle(seriesTitle);
  const code = `S${pad(season)}E${pad(episode)}`;
  const ep = episodeTitle ? ` - ${cleanTitle(episodeTitle)}` : "";
  return `${show} (${year}) - ${code}${ep}.strm`;
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
