import fs from "node:fs/promises";
import path from "node:path";
import { config, withKey } from "./config.js";
import { slugTvgId } from "./naming.js";
import { loadAllExtra } from "./sources.js";
import { withCountry } from "./country.js";
import { growCatalog, sweepCatalogHealth, catalogStatus } from "./catalog.js";
import { runQualityAudit, qualityAuditStatus } from "./services/qualityAudit.js";
import { webStreamrStatus } from "./services/webStreamrClient.js";

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

export const job = {
  running: false,
  phase: "idle",
  movies: 0,
  movieTitles: 0,
  shows: 0,
  episodes: 0,
  channels: 0,
  quality: null,
  health: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  detail: "",
};

const maintenance = {
  running: false,
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  detail: "",
  quality: null,
  health: null,
  error: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let channelCache = { at: 0, list: [] };

function decodeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(new RegExp("&" + "amp;", "g"), String.fromCharCode(38))
    .replace(new RegExp("&" + "lt;", "g"), String.fromCharCode(60))
    .replace(new RegExp("&" + "gt;", "g"), String.fromCharCode(62))
    .replace(new RegExp("&" + "quot;", "g"), String.fromCharCode(34))
    .trim();
}

function parseDlstreams247(html) {
  const seen = new Map();
  const re = /href="\/watch\.php\?id=(\d+)"[\s\S]{0,500}?card__title">([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!id || id === "00" || seen.has(id)) continue;
    const name = decodeHtml(m[2]);
    const group = /18\+|adult/i.test(name) ? "18+" : "24/7";
    seen.set(id, { ...withCountry({ id, name, group }), kind: "247" });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseSchedule(html) {
  const list = [];
  let group = "Live";
  let event = "";
  const re =
    /card__meta">([^<]+)<|schedule__eventTitle">([^<]+)<|href="\/watch\.php\?id=(\d+)"[^>]*title="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      group = decodeHtml(m[1]).slice(0, 60) || "Live";
      continue;
    }
    if (m[2]) {
      event = decodeHtml(m[2]);
      continue;
    }
    const id = m[3];
    if (!id || id === "00") continue;
    const chName = decodeHtml(m[4] || `Channel ${id}`);
    list.push({
      id,
      name: event ? `${event} — ${chName}` : chName,
      group: forM3u(group) || "Sports",
      kind: "sports",
    });
  }
  return list;
}

const UA = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html",
};

async function fetchHtml(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.text();
}

async function scrapeAll() {
  const [homeHtml, tvHtml] = await Promise.all([
    fetchHtml(config.dlstreamsHome),
    fetchHtml(config.dlstreams247),
  ]);
  const sports = parseSchedule(homeHtml);
  const tv = parseDlstreams247(tvHtml);
  log("scraped schedule", sports.length, "streams;", "24/7", tv.length, "channels");
  const list = [...sports, ...tv];
  if (!list.length) throw new Error("dlstreams parse empty");
  return list;
}

export async function loadChannels(force = false) {
  const stale = Date.now() - channelCache.at > config.liveRefreshMin * 60 * 1000;
  if (!force && channelCache.list.length && !stale) return channelCache.list;
  let list = [];
  try {
    list = await scrapeAll();
    const extra = await loadAllExtra();
    log("extra m3u", extra.length);
    list = [...list, ...extra.map((c) => ({ ...c, kind: c.kind || "ext" }))];
    list = list.map((ch) => (ch.kind === "247" ? withCountry({ ...ch, kind: "247" }) : ch));
    list.sort((a, b) => {
      const k = String(a.kind || "").localeCompare(String(b.kind || ""));
      const g = String(a.group || "").localeCompare(String(b.group || ""));
      return k || g || String(a.name || "").localeCompare(String(b.name || ""));
    });
  } catch (e) {
    log("dlstreams scrape failed, fallback dlhd", String(e.message || e));
    const r = await fetch(`${config.dlhdUrl}/api/channels`, {
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json();
    list = Array.isArray(data) ? data : data.channels || data.items || [];
  }
  channelCache = { at: Date.now(), list };
  return list;
}

function forM3u(s) {
  return String(s || "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/["\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function filterChannels(list, kind) {
  if (!kind || kind === "all") return list;
  const k = String(kind).toLowerCase();
  if (k === "247" || k === "tv") return list.filter((c) => c.kind === "247");
  if (k === "sports") return list.filter((c) => c.kind === "sports");
  if (k === "extra") return list.filter((c) => c.kind === "ext");
  return list.filter((c) => String(c.group || "").toLowerCase() === k);
}

export function buildM3u(list, kind = "all") {
  const rows = filterChannels(list, kind);
  const lines = [`#EXTM3U url-tvg="${config.epgUrl}" tvg-shift=0`];
  const base =
    kind === "sports" ? 5000 : kind === "extra" ? 8000 : kind === "247" ? 1000 : 1;
  rows.forEach((ch, i) => {
    const name = forM3u(ch.name || `Channel ${ch.id}`);
    const tvg = ch.kind === "ext" ? slugTvgId(name) || ch.id : `dlhd-${ch.id}`;
    const logo = ch.logo || ch.image || "";
    const group = forM3u(ch.group || ch.category || "Live") || "Live";
    const n = base + i;
    lines.push(
      `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${n}" group-title="${group}",${name}`,
    );
    const play = ch.kind === "ext" ? `/play/ext/${ch.id}` : `/play/live/${ch.id}.m3u8`;
    lines.push(`${withKey(config.publicUrl + play)}`);
  });
  return lines.join("\n") + "\n";
}

export async function writeLivePlaylist(force = true) {
  const list = await loadChannels(force);
  job.channels = list.length;
  await fs.mkdir(config.liveDir, { recursive: true });
  const files = [];
  for (const kind of ["all", "247", "sports", "extra"]) {
    const name = kind === "all" ? "playlist.m3u8" : `${kind}.m3u8`;
    const file = path.join(config.liveDir, name);
    await fs.writeFile(file, buildM3u(list, kind), "utf8");
    files.push(file);
  }
  return { file: files[0], count: list.length, files };
}

export function maintenanceStatus() {
  return {
    ...maintenance,
    webStreamr: webStreamrStatus(),
  };
}

export function triggerMaintenance() {
  if (maintenance.running) {
    return { started: false, reason: "already-running", ...maintenanceStatus() };
  }

  maintenance.running = true;
  maintenance.phase = "quality";
  maintenance.startedAt = Date.now();
  maintenance.finishedAt = null;
  maintenance.detail = "";
  maintenance.error = null;

  Promise.resolve()
    .then(async () => {
      maintenance.quality = await runQualityAudit({
        progress: (detail) => {
          maintenance.detail = detail;
        },
      });
      job.quality = maintenance.quality;

      maintenance.phase = "health";
      maintenance.detail = "";
      maintenance.health = await sweepCatalogHealth({
        progress: (detail) => {
          maintenance.detail = detail;
        },
      });
      job.health = maintenance.health;
      maintenance.phase = "done";
    })
    .catch((error) => {
      maintenance.error = String(error?.message || error);
      maintenance.phase = "error";
      log("maintenance failed", maintenance.error);
    })
    .finally(() => {
      maintenance.running = false;
      maintenance.finishedAt = Date.now();
      maintenance.detail = "";
    });

  return { started: true, ...maintenanceStatus() };
}

export async function generateLibrary(_options = {}) {
  if (job.running) return job;
  job.running = true;
  job.phase = "catalog";
  job.error = null;
  job.movies = 0;
  job.movieTitles = 0;
  job.shows = 0;
  job.episodes = 0;
  job.startedAt = Date.now();
  job.finishedAt = null;

  try {
    const growth = await growCatalog({
      progress: (detail) => {
        job.detail = detail;
      },
    });
    job.movies = growth.movieStrmsWritten;
    job.movieTitles = growth.movieTitlesAdded;
    job.shows = growth.showTitlesAdded;
    job.episodes = growth.episodeStrmsWritten;
    log(
      "generate catalog",
      `movieTitles=${job.movieTitles}`,
      `movieStrms=${job.movies}`,
      `shows=${job.shows}`,
      `episodeStrms=${job.episodes}`,
    );

    job.phase = "live";
    try {
      const live = await writeLivePlaylist(true);
      log("generate live", live.count, live.file);
    } catch (e) {
      log("generate live skipped", String(e.message || e));
    }

    job.phase = "done";
    await fs.mkdir(config.liveDir, { recursive: true });
    await fs.writeFile(
      path.join(config.liveDir, ".justone-first-run.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          movies: job.movies,
          movieTitles: job.movieTitles,
          shows: job.shows,
          episodes: job.episodes,
          channels: job.channels,
          quality: qualityAuditStatus(),
          catalog: catalogStatus(),
        },
        null,
        2,
      ),
    );

    const started = triggerMaintenance();
    log("background maintenance", started.started ? "started" : started.reason || "skipped");
  } catch (e) {
    job.error = String(e.message || e);
    job.phase = "error";
    log("generate failed", job.error);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    job.detail = "";
  }
  return job;
}

async function waitUp(name, url, tries = 8) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status < 500) {
        log("up", name, r.status);
        return true;
      }
      log("wait", name, r.status, i + "/" + tries);
    } catch (e) {
      log("wait", name, String(e.message || e), i + "/" + tries);
    }
    await sleep(1500);
  }
  log("down", name, url);
  return false;
}

export async function bootstrap() {
  log("bootstrap start");
  await waitUp("cinepro", config.cineproUrl);
  const liveOk = await waitUp("dlhd", `${config.dlhdUrl}/api/channels`);
  if (liveOk) {
    try {
      const live = await writeLivePlaylist(true);
      log("bootstrap live m3u", live.count, live.file);
    } catch (e) {
      log("bootstrap live failed", String(e.message || e));
    }
  } else {
    log("bootstrap: dlhd not up — STRM will still run; live later");
  }
  if (!config.generateOnStart) {
    log("bootstrap: GENERATE_ON_START=false");
    return;
  }
  if (!config.tmdbKey) {
    log("bootstrap: no TMDB_API_KEY, skip STRM");
    return;
  }

  const marker = path.join(config.liveDir, ".justone-first-run.json");
  try {
    await fs.access(marker);
    log("bootstrap: existing STRM library; incremental growth will continue on schedule");
    return;
  } catch {
    /* first run */
  }

  log(
    "bootstrap first-run incremental STRM",
    `initialMovies=${config.initialMoviesTarget}`,
    `initialShows=${config.initialShowsTarget}`,
  );
  generateLibrary().then(() => {
    log(
      "bootstrap done movieTitles=" + job.movieTitles,
      "shows=" + job.shows,
      "episodes=" + job.episodes,
      "live=" + job.channels,
    );
  });
}

export function libraryStatus() {
  return {
    ...job,
    cinepro: config.cineproUrl,
    paths: {
      movies1080: config.movies1080,
      movies4k: config.movies4k,
      tv1080: config.tv1080,
      tv4k: config.tv4k,
      live: config.liveDir,
      quarantine: config.catalogQuarantineRoot,
      catalogState: config.catalogStateDir,
    },
    catalog: catalogStatus(),
    qualityAudit: qualityAuditStatus(),
    maintenance: maintenanceStatus(),
    incremental: {
      initialMoviesTarget: config.initialMoviesTarget,
      initialShowsTarget: config.initialShowsTarget,
      moviesAddPerRun: config.moviesAddPerRun,
      showsAddPerRun: config.showsAddPerRun,
      maxMovies: config.maxMovies,
      maxShows: config.maxShows,
      refreshHours: config.catalogRefreshHours,
    },
    healthPolicy: {
      enabled: config.catalogHealthEnabled,
      intervalHours: config.catalogHealthIntervalHours,
      failureThreshold: config.catalogHealthFailureThreshold,
      quarantineDays: config.catalogHealthQuarantineDays,
      strict: config.catalogHealthStrict,
    },
    generateOnStart: config.generateOnStart,
    qualityFallback: config.qualityFallback,
    quality4kFallback: config.quality4kFallback,
  };
}
