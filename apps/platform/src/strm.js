import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function sanitize(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Write a movie .strm using Jellyfin-friendly layout:
 * movies/Title (Year)/Title (Year).strm
 */
export async function writeMovieStrm({ title, year, streamUrl, tmdbId }) {
  const folderName = year ? `${sanitize(title)} (${year})` : sanitize(title);
  const dir = path.join(config.moviesPath, folderName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${folderName}.strm`);
  const url = config.strmUseProxy
    ? `${config.publicUrl}/proxy/vod?url=${encodeURIComponent(streamUrl)}&tmdb=${tmdbId || ""}`
    : streamUrl;
  await fs.writeFile(filePath, url + "\n", "utf8");
  return { filePath, url };
}

/**
 * Write an episode .strm:
 * tv/Show Name/Season 01/Show Name - S01E02.strm
 */
export async function writeEpisodeStrm({
  showTitle,
  season,
  episode,
  episodeTitle,
  streamUrl,
  tmdbId,
}) {
  const show = sanitize(showTitle);
  const seasonDir = path.join(
    config.tvPath,
    show,
    `Season ${String(season).padStart(2, "0")}`,
  );
  await fs.mkdir(seasonDir, { recursive: true });
  const base = `${show} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const fileName = episodeTitle ? `${base} - ${sanitize(episodeTitle)}.strm` : `${base}.strm`;
  const filePath = path.join(seasonDir, fileName);
  const url = config.strmUseProxy
    ? `${config.publicUrl}/proxy/vod?url=${encodeURIComponent(streamUrl)}&tmdb=${tmdbId || ""}`
    : streamUrl;
  await fs.writeFile(filePath, url + "\n", "utf8");
  return { filePath, url };
}
