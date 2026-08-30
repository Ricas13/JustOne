import fs from "node:fs/promises";
import path from "node:path";
import { config, rootFor, withKey } from "./config.js";
import { movieFolder, seriesFolder, episodeFile } from "./naming.js";

const ensuredDirs = new Set();

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function ensureDir(dir) {
  if (ensuredDirs.has(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

async function writeIfChanged(filePath, content) {
  let changed = true;
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) changed = false;
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (changed) await fs.writeFile(filePath, content, "utf8");
  await sleep(config.strmIoDelayMs);
  return changed;
}

export async function writeMovieStrm({ title, year, tmdbId, quality }) {
  const { folder, file } = movieFolder(title, year, tmdbId);
  const dir = path.join(rootFor("movie", quality), folder);
  await ensureDir(dir);
  const filePath = path.join(dir, file);
  const url = withKey(`${config.publicUrl}/play/movie/${tmdbId}?quality=${quality}`);
  const changed = await writeIfChanged(filePath, url + "\n");
  return { filePath, url, changed };
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
  await ensureDir(dir);
  const fileName = episodeFile(showTitle, year || "0000", season, episode, episodeTitle);
  const filePath = path.join(dir, fileName);
  const url = withKey(
    `${config.publicUrl}/play/episode/${tmdbId}/${season}/${episode}?quality=${quality}`,
  );
  const changed = await writeIfChanged(filePath, url + "\n");
  return { filePath, url, changed };
}
