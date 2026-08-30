import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";
import { checkMovieAvailability, checkEpisodeAvailability } from "./resolve.js";

const TMDB = "https://api.themoviedb.org/3";
const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_YEAR = () => new Date().getFullYear();
const TMDB_MAX_PAGE = 500;
const TMDB_ID_RE = /\[tmdbid-(\d+)\]/i;
const EPISODE_URL_RE = /\/play\/episode\/(\d+)\/(\d+)\/(\d+)/i;

let stateCache = null;
let indexCache = null;
let statusCache = {
  initialized: false,
  movies: 0,
  shows: 0,
  quarantinedMovies: 0,
  quarantinedShows: 0,
  healthFailures: 0,
};

function log(...parts) {
  process.stdout.write(`[catalog] ${parts.map(String).join(" ")}\n`);
}

function stateFile() {
  return path.join(config.catalogStateDir, "catalog-state.json");
}

function defaultCursor() {
  return { year: CURRENT_YEAR(), page: 1, cycle: 0 };
}

function defaultState() {
  return {
    version: 1,
    movies: defaultCursor(),
    shows: defaultCursor(),
    lastGrowthAt: null,
    health: {
      lastRunAt: null,
      movieLastId: 0,
      showLastId: 0,
      newMovies: [],
      newShows: [],
      failures: {},
    },
  };
}

function normalizeCursor(raw) {
  const now = CURRENT_YEAR();
  return {
    year: Math.min(now, Math.max(config.discoverFromYear, Number(raw?.year || now))),
    page: Math.min(TMDB_MAX_PAGE, Math.max(1, Number(raw?.page || 1))),
    cycle: Math.max(0, Number(raw?.cycle || 0)),
  };
}

function normalizeState(raw) {
  const base = defaultState();
  return {
    ...base,
    ...(raw || {}),
    movies: normalizeCursor(raw?.movies),
    shows: normalizeCursor(raw?.shows),
    health: {
      ...base.health,
      ...(raw?.health || {}),
      newMovies: Array.isArray(raw?.health?.newMovies) ? raw.health.newMovies : [],
      newShows: Array.isArray(raw?.health?.newShows) ? raw.health.newShows : [],
      failures:
        raw?.health?.failures && typeof raw.health.failures === "object"
          ? raw.health.failures
          : {},
    },
  };
}

async function loadState() {
  if (stateCache) return stateCache;
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(), "utf8"));
    stateCache = normalizeState(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") log("state read failed", error?.message || error);
    stateCache = defaultState();
  }
  return stateCache;
}

async function saveState() {
  const state = await loadState();
  await fs.mkdir(config.catalogStateDir, { recursive: true });
  const file = stateFile();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function activeRoots(kind) {
  if (kind === "movie") {
    return [
      {
        active: config.movies1080,
        quarantine: path.join(config.catalogQuarantineRoot, "Movies", "Movies"),
      },
      {
        active: config.movies4k,
        quarantine: path.join(config.catalogQuarantineRoot, "Movies", "Movies-4K"),
      },
    ];
  }
  return [
    {
      active: config.tv1080,
      quarantine: path.join(config.catalogQuarantineRoot, "TV", "TV"),
    },
    {
      active: config.tv4k,
      quarantine: path.join(config.catalogQuarantineRoot, "TV", "TV-4K"),
    },
  ];
}

function addPath(map, id, folderPath) {
  const key = String(id || "");
  if (!key) return;
  let entry = map.get(key);
  if (!entry) {
    entry = { id: key, paths: new Set() };
    map.set(key, entry);
  }
  entry.paths.add(folderPath);
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function firstShowIdentity(showDir) {
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
        if (match) {
          return { tmdbId: match[1], season: Number(match[2]), episode: Number(match[3]) };
        }
      } catch {
        /* try the next STRM */
      }
    }
  }
  return null;
}

async function scanRoot(root, kind, target) {
  const entries = await readDirSafe(root);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(root, entry.name);
    let id = entry.name.match(TMDB_ID_RE)?.[1] || null;
    if (!id && kind === "show") id = (await firstShowIdentity(folderPath))?.tmdbId || null;
    if (id) addPath(target, id, folderPath);
  }
}

async function buildIndex() {
  if (indexCache) return indexCache;
  const index = {
    movies: new Map(),
    shows: new Map(),
    quarantinedMovies: new Map(),
    quarantinedShows: new Map(),
  };

  for (const pair of activeRoots("movie")) {
    await scanRoot(pair.active, "movie", index.movies);
    await scanRoot(pair.quarantine, "movie", index.quarantinedMovies);
  }
  for (const pair of activeRoots("show")) {
    await scanRoot(pair.active, "show", index.shows);
    await scanRoot(pair.quarantine, "show", index.quarantinedShows);
  }

  indexCache = index;
  refreshStatus(index);
  log(
    "index",
    `movies=${index.movies.size}`,
    `shows=${index.shows.size}`,
    `quarantineMovies=${index.quarantinedMovies.size}`,
    `quarantineShows=${index.quarantinedShows.size}`,
  );
  return index;
}

function refreshStatus(index = indexCache) {
  if (!index) return;
  const failures = stateCache?.health?.failures || {};
  statusCache = {
    ...statusCache,
    initialized: true,
    movies: index.movies.size,
    shows: index.shows.size,
    quarantinedMovies: index.quarantinedMovies.size,
    quarantinedShows: index.quarantinedShows.size,
    healthFailures: Object.keys(failures).length,
    cursors: stateCache
      ? {
          movies: { ...stateCache.movies },
          shows: { ...stateCache.shows },
        }
      : null,
    lastGrowthAt: stateCache?.lastGrowthAt || null,
    lastHealthAt: stateCache?.health?.lastRunAt || null,
  };
}

export function catalogStatus() {
  return { ...statusCache };
}

function knownCount(index, kind) {
  return kind === "movie"
    ? index.movies.size + index.quarantinedMovies.size
    : index.shows.size + index.quarantinedShows.size;
}

function knownIds(index, kind) {
  const active = kind === "movie" ? index.movies : index.shows;
  const quarantined = kind === "movie" ? index.quarantinedMovies : index.quarantinedShows;
  return new Set([...active.keys(), ...quarantined.keys()]);
}

function targetFor(index, kind) {
  const count = knownCount(index, kind);
  const initial = kind === "movie" ? config.initialMoviesTarget : config.initialShowsTarget;
  const perRun = kind === "movie" ? config.moviesAddPerRun : config.showsAddPerRun;
  const ceiling = kind === "movie" ? config.maxMovies : config.maxShows;
  let target = count < initial ? Math.max(perRun, initial - count) : perRun;
  if (ceiling > 0) target = Math.min(target, Math.max(0, ceiling - count));
  return Math.max(0, target);
}

async function tmdb(pathname, params = {}) {
  if (!config.tmdbKey) return null;
  const url = new URL(TMDB + pathname);
  url.searchParams.set("api_key", config.tmdbKey);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      log("tmdb", response.status, pathname);
      return null;
    }
    if (config.catalogTmdbDelayMs) await new Promise((resolve) => setTimeout(resolve, config.catalogTmdbDelayMs));
    return response.json();
  } catch (error) {
    log("tmdb fail", pathname, error?.message || error);
    return null;
  }
}

function freshEndpoints(kind) {
  return kind === "movie"
    ? ["/trending/movie/week", "/movie/popular", "/movie/now_playing", "/movie/upcoming"]
    : ["/trending/tv/week", "/tv/popular", "/tv/on_the_air"];
}

function advanceCursor(cursor, totalPages) {
  const maxPage = Math.max(1, Math.min(TMDB_MAX_PAGE, Number(totalPages || 1)));
  if (cursor.page < maxPage) {
    cursor.page += 1;
    return;
  }
  cursor.page = 1;
  cursor.year -= 1;
  if (cursor.year < config.discoverFromYear) {
    cursor.year = CURRENT_YEAR();
    cursor.cycle += 1;
  }
}

export function advanceCatalogCursor(cursor, totalPages, fromYear = config.discoverFromYear, currentYear = CURRENT_YEAR()) {
  const copy = { ...cursor };
  const maxPage = Math.max(1, Math.min(TMDB_MAX_PAGE, Number(totalPages || 1)));
  if (copy.page < maxPage) copy.page += 1;
  else {
    copy.page = 1;
    copy.year -= 1;
    if (copy.year < fromYear) {
      copy.year = currentYear;
      copy.cycle = Number(copy.cycle || 0) + 1;
    }
  }
  return copy;
}

function rowId(row) {
  return row?.id ? String(row.id) : null;
}

async function discoverRows(kind, target, existing, progress) {
  if (!target) return [];
  const state = await loadState();
  const cursor = kind === "movie" ? state.movies : state.shows;
  const selected = new Map();
  const add = (rows) => {
    for (const row of rows || []) {
      const id = rowId(row);
      if (!id || existing.has(id) || selected.has(id)) continue;
      selected.set(id, row);
      if (selected.size >= target) break;
    }
  };

  for (const endpoint of freshEndpoints(kind)) {
    for (let page = 1; page <= config.catalogFreshPages && selected.size < target; page += 1) {
      progress?.(`${kind} fresh ${endpoint} p${page}`);
      const data = await tmdb(endpoint, { page });
      add(data?.results);
    }
  }

  let pages = 0;
  while (selected.size < target && pages < config.catalogMaxDiscoveryPagesPerRun) {
    progress?.(`${kind} discover ${cursor.year} p${cursor.page} cycle=${cursor.cycle}`);
    const params = {
      page: cursor.page,
      sort_by: "popularity.desc",
      include_adult: "false",
    };
    if (kind === "movie") params.primary_release_year = cursor.year;
    else params.first_air_date_year = cursor.year;

    const data = await tmdb(kind === "movie" ? "/discover/movie" : "/discover/tv", params);
    pages += 1;
    add(data?.results);
    advanceCursor(cursor, data?.total_pages || 1);
    await saveState();
  }
  return [...selected.values()];
}

function queueNew(state, kind, id) {
  const key = kind === "movie" ? "newMovies" : "newShows";
  const queue = state.health[key];
  const value = String(id);
  if (!queue.includes(value)) queue.push(value);
  const max = Math.max(config.catalogHealthMoviesPerRun * 8, 10000);
  if (queue.length > max) queue.splice(0, queue.length - max);
}

function registerPath(index, kind, id, folderPath) {
  const map = kind === "movie" ? index.movies : index.shows;
  addPath(map, id, folderPath);
}

async function writeMovie(row, index, qualities) {
  const year = Number(String(row.release_date || "").slice(0, 4)) || 0;
  let writes = 0;
  for (const quality of qualities) {
    const result = await writeMovieStrm({ title: row.title, year, tmdbId: row.id, quality });
    registerPath(index, "movie", row.id, path.dirname(result.filePath));
    writes += 1;
  }
  return writes;
}

async function writeShow(row, index, qualities, progress) {
  const year = Number(String(row.first_air_date || "").slice(0, 4)) || 0;
  const detail = await tmdb(`/tv/${row.id}`, { append_to_response: "external_ids" });
  if (!detail) return { episodeWrites: 0, written: false };
  const tvdbId = detail?.external_ids?.tvdb_id;
  let seasons = (detail?.seasons || []).filter((season) => Number(season?.season_number) > 0);
  if (config.tvMaxSeasons > 0) seasons = seasons.slice(0, config.tvMaxSeasons);
  let episodeWrites = 0;
  let wroteAny = false;

  for (const season of seasons) {
    const seasonNum = Number(season.season_number);
    let count = Number(season.episode_count || 0);
    if (config.tvMaxEpisodes > 0) count = Math.min(count || config.tvMaxEpisodes, config.tvMaxEpisodes);
    if (!count) continue;
    for (let episode = 1; episode <= count; episode += 1) {
      progress?.(`show ${row.id} S${String(seasonNum).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
      for (const quality of qualities) {
        const result = await writeEpisodeStrm({
          showTitle: row.name,
          year,
          tmdbId: row.id,
          tvdbId,
          season: seasonNum,
          episode,
          quality,
        });
        const showDir = path.dirname(path.dirname(result.filePath));
        registerPath(index, "show", row.id, showDir);
        episodeWrites += 1;
        wroteAny = true;
      }
    }
  }
  return { episodeWrites, written: wroteAny };
}

export async function growCatalog({ progress } = {}) {
  const state = await loadState();
  const index = await buildIndex();
  const qualities = config.qualities.length ? config.qualities : ["1080p", "4k"];
  const movieTarget = targetFor(index, "movie");
  const showTarget = targetFor(index, "show");
  const stats = {
    movieTitlesAdded: 0,
    movieStrmsWritten: 0,
    showTitlesAdded: 0,
    episodeStrmsWritten: 0,
    movieTarget,
    showTarget,
  };

  log(
    "growth",
    `knownMovies=${knownCount(index, "movie")}`,
    `addMovies=${movieTarget}`,
    `knownShows=${knownCount(index, "show")}`,
    `addShows=${showTarget}`,
  );

  const movieRows = await discoverRows("movie", movieTarget, knownIds(index, "movie"), progress);
  for (const row of movieRows) {
    stats.movieStrmsWritten += await writeMovie(row, index, qualities);
    stats.movieTitlesAdded += 1;
    queueNew(state, "movie", row.id);
    if (stats.movieTitlesAdded % 100 === 0) log("movies added", stats.movieTitlesAdded);
  }

  const showRows = await discoverRows("show", showTarget, knownIds(index, "show"), progress);
  for (const row of showRows) {
    const result = await writeShow(row, index, qualities, progress);
    if (!result.written) continue;
    stats.episodeStrmsWritten += result.episodeWrites;
    stats.showTitlesAdded += 1;
    queueNew(state, "show", row.id);
    if (stats.showTitlesAdded % 25 === 0) log("shows added", stats.showTitlesAdded);
  }

  state.lastGrowthAt = new Date().toISOString();
  await saveState();
  refreshStatus(index);
  return stats;
}

async function showSamples(entry, limit = 2) {
  if (!entry) return [];
  const samples = [];
  const seen = new Set();
  for (const showDir of entry.paths) {
    const seasons = (await readDirSafe(showDir))
      .filter((item) => item.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const season of seasons) {
      const seasonDir = path.join(showDir, season.name);
      const files = (await readDirSafe(seasonDir))
        .filter((item) => item.isFile() && /\.strm$/i.test(item.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const file of files) {
        try {
          const body = await fs.readFile(path.join(seasonDir, file.name), "utf8");
          const match = body.match(EPISODE_URL_RE);
          if (!match) continue;
          const key = `${match[2]}:${match[3]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          samples.push({ tmdbId: match[1], season: Number(match[2]), episode: Number(match[3]) });
          if (samples.length >= limit) return samples;
        } catch {
          /* ignore one unreadable STRM */
        }
      }
    }
  }
  return samples;
}

async function availability(kind, id, entry) {
  if (kind === "movie") return checkMovieAvailability(id, { strict: config.catalogHealthStrict });
  const samples = await showSamples(entry, config.catalogHealthShowSamples);
  if (!samples.length) return { state: "indeterminate", reason: "no-sample-episodes" };
  let sawIndeterminate = false;
  for (const sample of samples) {
    const result = await checkEpisodeAvailability(sample.tmdbId, sample.season, sample.episode, {
      strict: config.catalogHealthStrict,
    });
    if (result.state === "available") return result;
    if (result.state === "indeterminate") sawIndeterminate = true;
  }
  return sawIndeterminate
    ? { state: "indeterminate", reason: "provider-error" }
    : { state: "unavailable", reason: "sample-episodes-unavailable" };
}

function rootPairFor(folderPath, kind, fromQuarantine = false) {
  for (const pair of activeRoots(kind)) {
    const root = fromQuarantine ? pair.quarantine : pair.active;
    if (folderPath === root || folderPath.startsWith(`${root}${path.sep}`)) return pair;
  }
  return null;
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

async function quarantine(kind, id, index) {
  const active = kind === "movie" ? index.movies : index.shows;
  const quarantined = kind === "movie" ? index.quarantinedMovies : index.quarantinedShows;
  const entry = active.get(String(id));
  if (!entry) return false;
  const moved = [];
  for (const folderPath of entry.paths) {
    const pair = rootPairFor(folderPath, kind, false);
    if (!pair) continue;
    const target = path.join(pair.quarantine, path.basename(folderPath));
    try {
      await moveFolder(folderPath, target);
      moved.push(target);
    } catch (error) {
      log("quarantine move failed", id, error?.message || error);
    }
  }
  if (!moved.length) return false;
  active.delete(String(id));
  for (const folderPath of moved) addPath(quarantined, id, folderPath);
  log("quarantined", kind, id, `copies=${moved.length}`);
  return true;
}

async function restore(kind, id, index) {
  const active = kind === "movie" ? index.movies : index.shows;
  const quarantined = kind === "movie" ? index.quarantinedMovies : index.quarantinedShows;
  const entry = quarantined.get(String(id));
  if (!entry) return false;
  const moved = [];
  for (const folderPath of entry.paths) {
    const pair = rootPairFor(folderPath, kind, true);
    if (!pair) continue;
    const target = path.join(pair.active, path.basename(folderPath));
    try {
      await fs.access(target);
      log("restore skipped existing target", target);
      continue;
    } catch {
      /* target absent */
    }
    try {
      await moveFolder(folderPath, target);
      moved.push(target);
    } catch (error) {
      log("restore move failed", id, error?.message || error);
    }
  }
  if (!moved.length) return false;
  quarantined.delete(String(id));
  for (const folderPath of moved) addPath(active, id, folderPath);
  log("restored", kind, id, `copies=${moved.length}`);
  return true;
}

function failureKey(kind, id) {
  return `${kind}:${id}`;
}

function dueFailure(entry, now) {
  if (!entry?.lastMissAt) return true;
  return now - Date.parse(entry.lastMissAt) >= config.catalogHealthFailureGapHours * 60 * 60 * 1000;
}

function shouldQuarantineFailure(entry, now) {
  if (!entry || entry.misses < config.catalogHealthFailureThreshold || !entry.firstMissAt) return false;
  return now - Date.parse(entry.firstMissAt) >= config.catalogHealthQuarantineDays * DAY_MS;
}

export function healthFailureDecision(entry, nowMs, { threshold = 3, quarantineDays = 7, gapHours = 24 } = {}) {
  const previous = entry || { misses: 0, firstMissAt: null, lastMissAt: null };
  const lastMs = previous.lastMissAt ? Date.parse(previous.lastMissAt) : 0;
  if (lastMs && nowMs - lastMs < gapHours * 60 * 60 * 1000) {
    return { ...previous, quarantine: false, incremented: false };
  }
  const next = {
    ...previous,
    misses: Number(previous.misses || 0) + 1,
    firstMissAt: previous.firstMissAt || new Date(nowMs).toISOString(),
    lastMissAt: new Date(nowMs).toISOString(),
  };
  const quarantine =
    next.misses >= threshold && nowMs - Date.parse(next.firstMissAt) >= quarantineDays * DAY_MS;
  return { ...next, quarantine, incremented: true };
}

function nextIds(map, lastId, limit, exclude = new Set()) {
  if (!limit || !map.size) return [];
  const ids = [...map.keys()].sort((a, b) => Number(a) - Number(b));
  let start = ids.findIndex((id) => Number(id) > Number(lastId || 0));
  if (start < 0) start = 0;
  const out = [];
  for (let i = 0; i < ids.length && out.length < limit; i += 1) {
    const id = ids[(start + i) % ids.length];
    if (!exclude.has(id)) out.push(id);
  }
  return out;
}

async function mapLimit(rows, limit, fn) {
  const queue = [...rows];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      await fn(row);
    }
  });
  await Promise.all(workers);
}

async function processHealth(kind, id, entry, index, state, now, isQuarantined = false) {
  const key = failureKey(kind, id);
  const result = await availability(kind, id, entry);
  const current = state.health.failures[key];

  if (result.state === "available") {
    if (isQuarantined) await restore(kind, id, index);
    delete state.health.failures[key];
    return "available";
  }
  if (result.state === "indeterminate") return "indeterminate";

  const decision = healthFailureDecision(current, now, {
    threshold: config.catalogHealthFailureThreshold,
    quarantineDays: config.catalogHealthQuarantineDays,
    gapHours: config.catalogHealthFailureGapHours,
  });
  state.health.failures[key] = {
    kind,
    id: String(id),
    misses: decision.misses,
    firstMissAt: decision.firstMissAt,
    lastMissAt: decision.lastMissAt,
    quarantined: Boolean(current?.quarantined || isQuarantined),
  };

  if (!isQuarantined && decision.quarantine) {
    const moved = await quarantine(kind, id, index);
    if (moved) state.health.failures[key].quarantined = true;
  }
  return "unavailable";
}

function takeQueued(state, kind, limit) {
  const key = kind === "movie" ? "newMovies" : "newShows";
  const queue = state.health[key];
  return queue.splice(0, Math.min(limit, queue.length)).map(String);
}

export async function sweepCatalogHealth({ force = false, progress } = {}) {
  if (!config.catalogHealthEnabled) return { skipped: true, reason: "disabled" };
  const state = await loadState();
  const index = await buildIndex();
  const now = Date.now();
  const intervalMs = config.catalogHealthIntervalHours * 60 * 60 * 1000;
  if (!force && state.health.lastRunAt && now - Date.parse(state.health.lastRunAt) < intervalMs) {
    return { skipped: true, reason: "not-due", nextAt: new Date(Date.parse(state.health.lastRunAt) + intervalMs).toISOString() };
  }

  const stats = {
    checked: 0,
    available: 0,
    unavailable: 0,
    indeterminate: 0,
    quarantined: 0,
    restored: 0,
  };
  const beforeQuarantine = index.quarantinedMovies.size + index.quarantinedShows.size;

  const retryRows = Object.values(state.health.failures)
    .filter((entry) => !entry.quarantined && dueFailure(entry, now))
    .slice(0, config.catalogHealthRetryFailuresPerRun);

  const quarantineRows = Object.values(state.health.failures)
    .filter((entry) => entry.quarantined)
    .filter((entry) => {
      const last = entry.lastMissAt ? Date.parse(entry.lastMissAt) : 0;
      return now - last >= config.catalogQuarantineRecheckDays * DAY_MS;
    })
    .slice(0, config.catalogHealthQuarantinedPerRun);

  const selected = [];
  for (const row of retryRows) selected.push({ kind: row.kind, id: String(row.id), quarantined: false });
  for (const row of quarantineRows) selected.push({ kind: row.kind, id: String(row.id), quarantined: true });

  const selectedKeys = new Set(selected.map((row) => failureKey(row.kind, row.id)));
  const newMovies = takeQueued(state, "movie", config.catalogHealthMoviesPerRun);
  const newShows = takeQueued(state, "show", config.catalogHealthShowsPerRun);
  for (const id of newMovies) {
    if (!selectedKeys.has(failureKey("movie", id)) && index.movies.has(id)) {
      selected.push({ kind: "movie", id, quarantined: false });
      selectedKeys.add(failureKey("movie", id));
    }
  }
  for (const id of newShows) {
    if (!selectedKeys.has(failureKey("show", id)) && index.shows.has(id)) {
      selected.push({ kind: "show", id, quarantined: false });
      selectedKeys.add(failureKey("show", id));
    }
  }

  const movieSlots = Math.max(0, config.catalogHealthMoviesPerRun - newMovies.length);
  const showSlots = Math.max(0, config.catalogHealthShowsPerRun - newShows.length);
  const movieIds = nextIds(index.movies, state.health.movieLastId, movieSlots, new Set(newMovies));
  const showIds = nextIds(index.shows, state.health.showLastId, showSlots, new Set(newShows));
  if (movieIds.length) state.health.movieLastId = movieIds[movieIds.length - 1];
  if (showIds.length) state.health.showLastId = showIds[showIds.length - 1];
  for (const id of movieIds) {
    if (!selectedKeys.has(failureKey("movie", id))) selected.push({ kind: "movie", id, quarantined: false });
  }
  for (const id of showIds) {
    if (!selectedKeys.has(failureKey("show", id))) selected.push({ kind: "show", id, quarantined: false });
  }

  await mapLimit(selected, config.catalogHealthConcurrency, async (row) => {
    const map = row.quarantined
      ? row.kind === "movie"
        ? index.quarantinedMovies
        : index.quarantinedShows
      : row.kind === "movie"
        ? index.movies
        : index.shows;
    const entry = map.get(String(row.id));
    if (!entry) return;
    progress?.(`health ${row.kind} ${row.id}`);
    const outcome = await processHealth(row.kind, row.id, entry, index, state, now, row.quarantined);
    stats.checked += 1;
    stats[outcome] += 1;
  });

  const afterQuarantine = index.quarantinedMovies.size + index.quarantinedShows.size;
  if (afterQuarantine > beforeQuarantine) stats.quarantined = afterQuarantine - beforeQuarantine;
  if (afterQuarantine < beforeQuarantine) stats.restored = beforeQuarantine - afterQuarantine;

  state.health.lastRunAt = new Date(now).toISOString();
  await saveState();
  refreshStatus(index);
  log(
    "health",
    `checked=${stats.checked}`,
    `available=${stats.available}`,
    `unavailable=${stats.unavailable}`,
    `indeterminate=${stats.indeterminate}`,
    `quarantined=${stats.quarantined}`,
    `restored=${stats.restored}`,
  );
  return stats;
}
