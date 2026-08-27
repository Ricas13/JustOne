import fs from "node:fs/promises";
import path from "node:path";
import { config, rootFor, withKey } from "./config.js";
import { movieFolder, seriesFolder, episodeFile } from "./naming.js";

export async function writeMovieStrm({ title, year, tmdbId, quality }) {
  const { folder, file } = movieFolder(title, year, tmdbId);
  const dir = path.join(rootFor("movie", quality), folder);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, file);
  const url = withKey(`${config.publicUrl}/play/movie/${tmdbId}?quality=${quality}`);
  await fs.writeFile(filePath, url + "\n", "utf8");
  return { filePath, url };
}

export async function writeEpisodeStrm({
  showTitle,
  year,
  tmdbId,
  tvdbId,
  season,
  episode,
  episodeTitle,
  quality,
}) {
  const show = seriesFolder(showTitle, year || "0000", { tvdbId, tmdbId });
  const dir = path.join(
    rootFor("tv", quality),
    show,
    `Season ${String(season).padStart(2, "0")}`,
  );
  await fs.mkdir(dir, { recursive: true });
  const fileName = episodeFile(showTitle, year || "0000", season, episode, episodeTitle);
  const filePath = path.join(dir, fileName);
  const url = withKey(
    `${config.publicUrl}/play/episode/${tmdbId}/${season}/${episode}?quality=${quality}`,
  );
  await fs.writeFile(filePath, url + "\n", "utf8");
  return { filePath, url };
}
