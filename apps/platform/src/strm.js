import fs from "node:fs/promises";
import path from "node:path";
import { config, rootFor, withKey } from "./config.js";
import { cleanTitle, movieFolder, seriesFolder, episodeFile } from "./naming.js";

const TMDB = "https://api.themoviedb.org/3";
const ensuredDirs = new Set();
const seasonTitleCache = new Map();
const SIX_HOURS = 6 * 60 * 60 * 1000;

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

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (e) {
    // Legacy filename formats were not length-bounded. On filesystems with a
    // 255-byte component limit such a historical path cannot exist at all, so
    // ENAMETOOLONG is equivalent to ENOENT for cleanup purposes.
    if (e?.code === "ENOENT" || e?.code === "ENAMETOOLONG") return false;
    throw e;
  }
}

async function seasonEpisodeTitles(tmdbId, season) {
  if (!config.tmdbKey || !tmdbId) return new Map();
  const key = `${tmdbId}:${season}`;
  const now = Date.now();
  const hit = seasonTitleCache.get(key);
  if (hit && hit.exp > now) return hit.promise;

  const promise = (async () => {
    try {
      const url = new URL(`${TMDB}/tv/${tmdbId}/season/${season}`);
      url.searchParams.set("api_key", config.tmdbKey);
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return new Map();
      const data = await r.json();
      return new Map(
        (data?.episodes || [])
          .filter((ep) => Number.isFinite(Number(ep?.episode_number)))
          .map((ep) => [Number(ep.episode_number), String(ep.name || "").trim()]),
      );
    } catch {
      return new Map();
    }
  })();

  seasonTitleCache.set(key, { exp: now + SIX_HOURS, promise });
  return promise;
}

async function resolveEpisodeTitle(tmdbId, season, episode, supplied) {
  const provided = String(supplied || "").trim();
  if (provided) return provided;
  const titles = await seasonEpisodeTitles(tmdbId, season);
  return titles.get(Number(episode)) || "";
}

function legacyEpisodeFile(showTitle, year, season, episode, episodeTitle = "") {
  const show = cleanTitle(showTitle);
  const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  const ep = episodeTitle ? ` - ${cleanTitle(episodeTitle)}` : "";
  return `${show} (${year}) - ${code}${ep}.strm`;
}

export async function writeMovieStrm({ title, year, tmdbId, quality }) {
  const { folder, file } = movieFolder(title, year, tmdbId);
  const dir = path.join(rootFor("movie", quality), folder);
  await ensureDir(dir);
  const filePath = path.join(dir, file);
  const url = withKey(`${config.publicUrl}/play/movie/${tmdbId}?quality=${quality}`);
  const changed = await writeIfChanged(filePath, url + "\n");

  // Remove both historical filename styles after the canonical ID-bearing file
  // has been written successfully.
  const legacyNames = new Set([
    `${folder}.strm`,
    file.replace(new RegExp(`\\s+\\[tmdbid-${tmdbId}\\](?=\\.strm$)`, "i"), ""),
  ]);
  for (const legacyName of legacyNames) {
    const legacyPath = path.join(dir, legacyName);
    if (legacyPath !== filePath) await unlinkIfExists(legacyPath);
  }

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
  const safeYear = year || "0000";
  const resolvedTitle = await resolveEpisodeTitle(tmdbId, season, episode, episodeTitle);
  const show = seriesFolder(showTitle, safeYear, { tvdbId, tmdbId });
  const root = rootFor("tv", quality);
  const seasonFolder = `Season ${String(season).padStart(2, "0")}`;
  const dir = path.join(root, show, seasonFolder);
  await ensureDir(dir);

  const fileName = episodeFile(showTitle, safeYear, season, episode, resolvedTitle, tmdbId);
  const filePath = path.join(dir, fileName);
  const url = withKey(
    `${config.publicUrl}/play/episode/${tmdbId}/${season}/${episode}?quality=${quality}`,
  );
  const changed = await writeIfChanged(filePath, url + "\n");

  const oldShow = tvdbId
    ? `${cleanTitle(showTitle)} (${safeYear}) [tvdbid-${tvdbId}]`
    : `${cleanTitle(showTitle)} (${safeYear}) [tmdbid-${tmdbId}]`;
  const legacyNames = new Set([
    legacyEpisodeFile(showTitle, safeYear, season, episode),
    legacyEpisodeFile(showTitle, safeYear, season, episode, resolvedTitle),
    episodeFile(showTitle, safeYear, season, episode, resolvedTitle),
  ]);
  const legacyDirs = new Set([dir, path.join(root, oldShow, seasonFolder)]);
  for (const legacyDir of legacyDirs) {
    for (const legacyName of legacyNames) {
      const legacyPath = path.join(legacyDir, legacyName);
      if (legacyPath !== filePath) await unlinkIfExists(legacyPath);
    }
  }

  return { filePath, url, changed, episodeTitle: resolvedTitle };
}
