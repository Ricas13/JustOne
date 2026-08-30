import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import {
  inspectMovieQualities,
  inspectEpisodeQualities,
  validateMovie4k,
  validateEpisode4k,
} from "./qualityAvailability.js";

const TMDB_ID_RE = /\[tmdbid-(\d+)\]/i;
const EPISODE_URL_RE = /\/play\/episode\/(\d+)\/(\d+)\/(\d+)/i;
const MOVIES_PER_RUN = Math.max(0, Number(process.env.QUALITY_AUDIT_MOVIES_PER_RUN || 2000));
const SHOWS_PER_RUN = Math.max(0, Number(process.env.QUALITY_AUDIT_SHOWS_PER_RUN || 150));
const SHOW_SAMPLES = Math.max(1, Math.min(5, Number(process.env.QUALITY_AUDIT_SHOW_SAMPLES || 3)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.QUALITY_AUDIT_CONCURRENCY || 4)));
const QUALITY_QUARANTINE =
  process.env.QUALITY_QUARANTINE_ROOT || path.join(config.catalogQuarantineRoot, "quality");

let status = {
  running: false,
  lastRunAt: null,
  moviesChecked: 0,
  moviesPromoted: 0,
  moviesQuarantined: 0,
  moviesIndeterminate: 0,
  showsChecked: 0,
  showsPromoted: 0,
  showsQuarantined: 0,
  showsIndeterminate: 0,
  namesMigrated: 0,
  error: null,
};

function log(...parts) {
  process.stdout.write(`[quality-audit] ${parts.map(String).join(" ")}\n`);
}

function stateFile() {
  return path.join(config.catalogStateDir, "quality-audit.json");
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function loadState() {
  try {
    return {
      movieLastId: 0,
      showLastId: 0,
      ...JSON.parse(await fs.readFile(stateFile(), "utf8")),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") log("state read failed", error?.message || error);
    return { movieLastId: 0, showLastId: 0 };
  }
}

async function saveState(state) {
  await fs.mkdir(config.catalogStateDir, { recursive: true });
  const target = stateFile();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, target);
}

function add(map, id, folderPath) {
  if (!id) return;
  map.set(String(id), folderPath);
}

async function firstEpisodeRef(showDir) {
  const seasons = (await readDirSafe(showDir))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const season of seasons) {
    const seasonDir = path.join(showDir, season.name);
    const files = (await readDirSafe(seasonDir))
      .filter((entry) => entry.isFile() && /\.strm$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const file of files.slice(0, 3)) {
      try {
        const body = await fs.readFile(path.join(seasonDir, file.name), "utf8");
        const match = body.match(EPISODE_URL_RE);
        if (match) return { tmdbId: match[1], season: Number(match[2]), episode: Number(match[3]) };
      } catch {
        /* try another file */
      }
    }
  }
  return null;
}

async function scanRoot(root, kind) {
  const map = new Map();
  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(root, entry.name);
    let id = entry.name.match(TMDB_ID_RE)?.[1] || null;
    if (!id && kind === "show") id = (await firstEpisodeRef(folderPath))?.tmdbId || null;
    add(map, id, folderPath);
  }
  return map;
}

function nextIds(ids, lastId, limit) {
  const values = [...ids];
  if (!limit || !values.length) return [];
  const sorted = values.sort((a, b) => Number(a) - Number(b));
  let start = sorted.findIndex((id) => Number(id) > Number(lastId || 0));
  if (start < 0) start = 0;
  const out = [];
  for (let i = 0; i < sorted.length && out.length < limit; i += 1) {
    out.push(sorted[(start + i) % sorted.length]);
  }
  return out;
}

async function mapLimit(rows, limit, fn) {
  const queue = [...rows];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length || 1)) },
    async () => {
      while (queue.length) {
        const row = queue.shift();
        await fn(row);
      }
    },
  );
  await Promise.all(workers);
}

async function moveFolder(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.cp(source, target, { recursive: true, errorOnExist: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

async function copyFolder(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, errorOnExist: true });
}

function replaceQuality(body, quality) {
  const text = String(body || "");
  if (/([?&])quality=[^&\s]+/i.test(text)) {
    return text.replace(/([?&])quality=[^&\s]+/i, `$1quality=${quality}`);
  }
  const newline = text.endsWith("\n") ? "\n" : "";
  const value = text.trim();
  if (!value) return text;
  return `${value}${value.includes("?") ? "&" : "?"}quality=${quality}${newline}`;
}

async function rewriteTreeQuality(root, quality) {
  const entries = await readDirSafe(root);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await rewriteTreeQuality(full, quality);
      continue;
    }
    if (!entry.isFile() || !/\.strm$/i.test(entry.name)) continue;
    const body = await fs.readFile(full, "utf8");
    const next = replaceQuality(body, quality);
    if (next !== body) await fs.writeFile(full, next, "utf8");
  }
}

async function renameSafe(from, to) {
  if (from === to) return false;
  if (await exists(to)) {
    const [oldBody, newBody] = await Promise.all([
      fs.readFile(from, "utf8").catch(() => null),
      fs.readFile(to, "utf8").catch(() => null),
    ]);
    if (oldBody === newBody) {
      await fs.unlink(from);
      return true;
    }
    return false;
  }
  await fs.rename(from, to);
  return true;
}

async function migrateMovieFilename(folderPath, tmdbId) {
  const folder = path.basename(folderPath);
  const base = folder.replace(/\s+\[tmdbid-\d+\]\s*$/i, "").trim();
  const targetName = `${base} [tmdbid-${tmdbId}].strm`;
  let migrated = 0;
  for (const entry of await readDirSafe(folderPath)) {
    if (!entry.isFile() || !/\.strm$/i.test(entry.name) || entry.name === targetName) continue;
    if (await renameSafe(path.join(folderPath, entry.name), path.join(folderPath, targetName))) migrated += 1;
  }
  return migrated;
}

async function migrateShowFilenames(showDir, tmdbId) {
  let migrated = 0;
  for (const season of await readDirSafe(showDir)) {
    if (!season.isDirectory()) continue;
    const seasonDir = path.join(showDir, season.name);
    for (const entry of await readDirSafe(seasonDir)) {
      if (!entry.isFile() || !/\.strm$/i.test(entry.name)) continue;
      if (new RegExp(`\\[tmdbid-${tmdbId}\\]\\.strm$`, "i").test(entry.name)) continue;
      const stem = entry.name
        .replace(/\s+\[tmdbid-\d+\](?=\.strm$)/i, "")
        .replace(/\.strm$/i, "");
      const target = path.join(seasonDir, `${stem} [tmdbid-${tmdbId}].strm`);
      if (await renameSafe(path.join(seasonDir, entry.name), target)) migrated += 1;
    }
  }
  return migrated;
}

function canAssertNo4k(result) {
  return Boolean(result?.complete && !result.has4k && !result.qualities?.includes("unknown"));
}

function movieQuarantineRoot() {
  return path.join(QUALITY_QUARANTINE, "Movies-4K");
}

function showQuarantineRoot() {
  return path.join(QUALITY_QUARANTINE, "TV-4K");
}

async function quarantineMovie(id, maps, stats, fourK) {
  if (!fourK) return;
  const target = path.join(movieQuarantineRoot(), path.basename(fourK));
  if (!(await exists(target))) {
    await moveFolder(fourK, target);
    maps.fourK.delete(id);
    maps.quarantine.set(id, target);
    stats.moviesQuarantined += 1;
  }
}

async function auditMovie(id, maps, stats) {
  const normal = maps.normal.get(id);
  let fourK = maps.fourK.get(id);
  const quarantined = maps.quarantine.get(id);

  if (normal) stats.namesMigrated += await migrateMovieFilename(normal, id);
  if (fourK) stats.namesMigrated += await migrateMovieFilename(fourK, id);

  const result = await inspectMovieQualities(id);
  stats.moviesChecked += 1;

  if (result.has4k) {
    const playable = await validateMovie4k(id);
    if (playable.state === "indeterminate") {
      stats.moviesIndeterminate += 1;
      return;
    }
    if (playable.state !== "available") {
      await quarantineMovie(id, maps, stats, fourK);
      return;
    }

    if (!fourK && quarantined) {
      const target = path.join(config.movies4k, path.basename(quarantined));
      if (!(await exists(target))) {
        await moveFolder(quarantined, target);
        fourK = target;
        maps.fourK.set(id, target);
        maps.quarantine.delete(id);
        stats.moviesPromoted += 1;
      }
    }
    if (!fourK && normal) {
      const target = path.join(config.movies4k, path.basename(normal));
      if (!(await exists(target))) {
        await copyFolder(normal, target);
        fourK = target;
        maps.fourK.set(id, target);
        stats.moviesPromoted += 1;
      }
    }
    if (fourK) {
      await rewriteTreeQuality(fourK, "4k");
      stats.namesMigrated += await migrateMovieFilename(fourK, id);
    }
    return;
  }

  if (!canAssertNo4k(result)) {
    stats.moviesIndeterminate += 1;
    return;
  }

  await quarantineMovie(id, maps, stats, fourK);
}

async function episodeRefs(showDir, limit) {
  const files = [];
  const seasons = (await readDirSafe(showDir))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const season of seasons) {
    const seasonDir = path.join(showDir, season.name);
    for (const file of (await readDirSafe(seasonDir))
      .filter((entry) => entry.isFile() && /\.strm$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      files.push(path.join(seasonDir, file.name));
    }
  }
  if (!files.length) return [];

  const indexes = new Set();
  if (limit === 1 || files.length === 1) indexes.add(0);
  else {
    for (let i = 0; i < limit; i += 1) {
      indexes.add(Math.round((i * (files.length - 1)) / (limit - 1)));
    }
  }

  const refs = [];
  for (const index of indexes) {
    try {
      const body = await fs.readFile(files[index], "utf8");
      const match = body.match(EPISODE_URL_RE);
      if (match) refs.push({ tmdbId: match[1], season: Number(match[2]), episode: Number(match[3]) });
    } catch {
      /* ignore one unreadable sample */
    }
  }
  return refs;
}

async function quarantineShow(id, maps, stats, fourK) {
  if (!fourK) return;
  const target = path.join(showQuarantineRoot(), path.basename(fourK));
  if (!(await exists(target))) {
    await moveFolder(fourK, target);
    maps.fourK.delete(id);
    maps.quarantine.set(id, target);
    stats.showsQuarantined += 1;
  }
}

async function auditShow(id, maps, stats) {
  const normal = maps.normal.get(id);
  let fourK = maps.fourK.get(id);
  const quarantined = maps.quarantine.get(id);
  const sampleRoot = normal || fourK || quarantined;
  if (!sampleRoot) return;

  if (normal) stats.namesMigrated += await migrateShowFilenames(normal, id);
  if (fourK) stats.namesMigrated += await migrateShowFilenames(fourK, id);

  const refs = await episodeRefs(sampleRoot, SHOW_SAMPLES);
  if (!refs.length) {
    stats.showsIndeterminate += 1;
    return;
  }

  const results = await Promise.all(
    refs.map(async (ref) => {
      const advertised = await inspectEpisodeQualities(ref.tmdbId, ref.season, ref.episode);
      const playable = advertised.has4k
        ? await validateEpisode4k(ref.tmdbId, ref.season, ref.episode)
        : null;
      return { advertised, playable };
    }),
  );
  stats.showsChecked += 1;

  const allSamples4k =
    results.length === refs.length &&
    results.every(
      ({ advertised, playable }) => advertised.has4k && playable?.state === "available",
    );
  const definitelyNotConsistent4k = results.some(
    ({ advertised, playable }) =>
      canAssertNo4k(advertised) ||
      (advertised.has4k && playable?.state === "unavailable"),
  );
  const hasIndeterminate = results.some(
    ({ advertised, playable }) =>
      (!advertised.has4k && !canAssertNo4k(advertised)) ||
      (advertised.has4k && playable?.state === "indeterminate"),
  );

  if (allSamples4k) {
    if (!fourK && quarantined) {
      const target = path.join(config.tv4k, path.basename(quarantined));
      if (!(await exists(target))) {
        await moveFolder(quarantined, target);
        fourK = target;
        maps.fourK.set(id, target);
        maps.quarantine.delete(id);
        stats.showsPromoted += 1;
      }
    }
    if (!fourK && normal) {
      const target = path.join(config.tv4k, path.basename(normal));
      if (!(await exists(target))) {
        await copyFolder(normal, target);
        fourK = target;
        maps.fourK.set(id, target);
        stats.showsPromoted += 1;
      }
    }
    if (fourK) {
      await rewriteTreeQuality(fourK, "4k");
      stats.namesMigrated += await migrateShowFilenames(fourK, id);
    }
    return;
  }

  if (!definitelyNotConsistent4k || hasIndeterminate) {
    stats.showsIndeterminate += 1;
    return;
  }

  await quarantineShow(id, maps, stats, fourK);
}

export function qualityAuditStatus() {
  return { ...status };
}

export async function runQualityAudit({ progress } = {}) {
  if (status.running) return { ...status, skipped: true, reason: "already-running" };
  status = {
    ...status,
    running: true,
    error: null,
    moviesChecked: 0,
    moviesPromoted: 0,
    moviesQuarantined: 0,
    moviesIndeterminate: 0,
    showsChecked: 0,
    showsPromoted: 0,
    showsQuarantined: 0,
    showsIndeterminate: 0,
    namesMigrated: 0,
  };

  try {
    const state = await loadState();
    const movieMaps = {
      normal: await scanRoot(config.movies1080, "movie"),
      fourK: await scanRoot(config.movies4k, "movie"),
      quarantine: await scanRoot(movieQuarantineRoot(), "movie"),
    };
    const movieIds = nextIds(
      new Set([...movieMaps.normal.keys(), ...movieMaps.fourK.keys(), ...movieMaps.quarantine.keys()]),
      state.movieLastId,
      MOVIES_PER_RUN,
    );
    await mapLimit(movieIds, CONCURRENCY, async (id) => {
      progress?.(`4k movie ${id}`);
      try {
        await auditMovie(id, movieMaps, status);
      } catch (error) {
        status.moviesIndeterminate += 1;
        log("movie", id, "failed", error?.message || error);
      }
    });
    if (movieIds.length) state.movieLastId = movieIds[movieIds.length - 1];

    const showMaps = {
      normal: await scanRoot(config.tv1080, "show"),
      fourK: await scanRoot(config.tv4k, "show"),
      quarantine: await scanRoot(showQuarantineRoot(), "show"),
    };
    const showIds = nextIds(
      new Set([...showMaps.normal.keys(), ...showMaps.fourK.keys(), ...showMaps.quarantine.keys()]),
      state.showLastId,
      SHOWS_PER_RUN,
    );
    await mapLimit(showIds, CONCURRENCY, async (id) => {
      progress?.(`4k show ${id}`);
      try {
        await auditShow(id, showMaps, status);
      } catch (error) {
        status.showsIndeterminate += 1;
        log("show", id, "failed", error?.message || error);
      }
    });
    if (showIds.length) state.showLastId = showIds[showIds.length - 1];

    state.lastRunAt = new Date().toISOString();
    await saveState(state);
    status.lastRunAt = state.lastRunAt;
    log(
      `movies=${status.moviesChecked}`,
      `movie4k+${status.moviesPromoted}`,
      `movie4k-${status.moviesQuarantined}`,
      `shows=${status.showsChecked}`,
      `show4k+${status.showsPromoted}`,
      `show4k-${status.showsQuarantined}`,
      `renamed=${status.namesMigrated}`,
    );
  } catch (error) {
    status.error = String(error?.message || error);
    log("failed", status.error);
  } finally {
    status.running = false;
  }
  return { ...status };
}
