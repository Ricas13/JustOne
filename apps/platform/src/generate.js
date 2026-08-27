import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";
import { slugTvgId } from "./naming.js";
import { loadAllExtra } from "./sources.js";

const TMDB = "https://api.themoviedb.org/3";

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

export const job = {
  running: false,
  phase: "idle",
  movies: 0,
  episodes: 0,
  channels: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  detail: "",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tmdb(pathname, params = {}) {
  if (!config.tmdbKey) return null;
  const url = new URL(TMDB + pathname);
  url.searchParams.set("api_key", config.tmdbKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      log("tmdb", r.status, pathname);
      return null;
    }
    await sleep(200);
    return r.json();
  } catch (e) {
    log("tmdb fail", pathname, String(e.message || e));
    return null;
  }
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
    seen.set(id, { id, name, group });
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
    const name = event ? `${event} — ${chName}` : chName;
    list.push({ id, name, group: group || "Live" });
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
    list = [...list, ...extra];
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

export function buildM3u(list) {
  const lines = [`#EXTM3U url-tvg="${config.epgUrl}" tvg-shift=0`];
  list.forEach((ch, i) => {
    const name = forM3u(ch.name || `Channel ${ch.id}`);
    const tvg = slugTvgId(name) || `dlhd-${ch.id}`;
    const logo = ch.logo || ch.image || "";
    const group = forM3u(ch.group || ch.category || "Live") || "Live";
    lines.push(
      `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${i + 1}" group-title="${group}",${name}`,
    );
    const play =
      ch.kind === "ext" ? `/play/ext/${ch.id}` : `/play/live/${ch.id}.ts`;
    lines.push(`${config.publicUrl}${play}`);
  });
  return lines.join("\n") + "\n";
}

export async function writeLivePlaylist(force = true) {
  const list = await loadChannels(force);
  job.channels = list.length;
  const body = buildM3u(list);
  await fs.mkdir(config.liveDir, { recursive: true });
  const file = path.join(config.liveDir, "playlist.m3u8");
  await fs.writeFile(file, body, "utf8");
  return { file, count: list.length, body };
}

async function uniqueMovies(pages) {
  const seen = new Map();
  const add = (rows) => {
    for (const m of rows || []) {
      if (m?.id && !seen.has(m.id)) seen.set(m.id, m);
    }
  };
  const lists = [
    "/trending/movie/week",
    "/trending/movie/day",
    "/movie/popular",
    "/movie/top_rated",
    "/movie/now_playing",
    "/movie/upcoming",
  ];
  const p = Math.min(pages, 50);
  for (const endpoint of lists) {
    for (let page = 1; page <= p; page++) {
      job.detail = `${endpoint} p${page}`;
      log("tmdb", job.detail, "n=" + seen.size);
      const data = await tmdb(endpoint, { page });
      add(data?.results);
      if (seen.size >= config.maxMovies) return [...seen.values()];
    }
  }
  const discPages = Math.min(p, 20);
  for (let page = 1; page <= discPages; page++) {
    job.detail = `discover/movie p${page}`;
    const data = await tmdb("/discover/movie", {
      page,
      sort_by: "vote_count.desc",
      "vote_count.gte": 50,
      include_adult: "false",
    });
    add(data?.results);
    if (seen.size >= config.maxMovies) return [...seen.values()];
  }
  const now = new Date().getFullYear();
  const from = Math.max(1950, config.discoverFromYear);
  for (let year = now; year >= from; year--) {
    job.detail = `discover ${year}`;
    const data = await tmdb("/discover/movie", {
      page: 1,
      sort_by: "popularity.desc",
      primary_release_year: year,
      include_adult: "false",
    });
    add(data?.results);
    if (seen.size >= config.maxMovies) break;
  }
  return [...seen.values()];
}

async function uniqueShows(pages) {
  const seen = new Map();
  const add = (rows) => {
    for (const s of rows || []) {
      if (s?.id && !seen.has(s.id)) seen.set(s.id, s);
    }
  };
  const lists = [
    "/trending/tv/week",
    "/trending/tv/day",
    "/tv/popular",
    "/tv/top_rated",
    "/tv/on_the_air",
  ];
  const p = Math.min(pages, 40);
  for (const endpoint of lists) {
    for (let page = 1; page <= p; page++) {
      job.detail = `${endpoint} p${page}`;
      log("tmdb", job.detail, "n=" + seen.size);
      const data = await tmdb(endpoint, { page });
      add(data?.results);
      if (seen.size >= config.maxShows) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

export async function generateLibrary({
  moviePages = config.moviePages,
  tvPages = config.tvPages,
  maxEpisodes = config.tvMaxEpisodes,
} = {}) {
  if (job.running) return job;
  job.running = true;
  job.phase = "movies";
  job.error = null;
  job.movies = 0;
  job.episodes = 0;
  job.startedAt = Date.now();
  job.finishedAt = null;
  const qs = config.qualities.length ? config.qualities : ["1080p", "4k"];
  try {
    log("generate: fetching movie lists");
    const movies = await uniqueMovies(Math.min(moviePages, 50));
    log("generate: writing", movies.length, "movies ×", qs.join(","));
    for (const m of movies) {
      const year = Number(String(m.release_date || "").slice(0, 4)) || 0;
      for (const quality of qs) {
        await writeMovieStrm({ title: m.title, year, tmdbId: m.id, quality });
        job.movies += 1;
      }
      if (job.movies % 100 === 0) log("generate movies", job.movies);
    }
    job.phase = "tv";
    log("generate: fetching tv lists");
    const shows = await uniqueShows(Math.min(tvPages, 40));
    log("generate: writing", shows.length, "shows");
    const maxSeasons = config.tvMaxSeasons;
    for (const s of shows) {
      const year = Number(String(s.first_air_date || "").slice(0, 4)) || 0;
      const detail = await tmdb(`/tv/${s.id}`, { append_to_response: "external_ids" });
      const tvdbId = detail?.external_ids?.tvdb_id;
      const seasons = (detail?.seasons || [])
        .filter((x) => x.season_number > 0)
        .slice(0, maxSeasons);
      for (const sn of seasons) {
        const seasonNum = sn.season_number;
        const count = Math.min(sn.episode_count || maxEpisodes, maxEpisodes);
        for (let ep = 1; ep <= count; ep++) {
          for (const quality of qs) {
            await writeEpisodeStrm({
              showTitle: s.name,
              year,
              tmdbId: s.id,
              tvdbId,
              season: seasonNum,
              episode: ep,
              quality,
            });
            job.episodes += 1;
          }
        }
      }
      if (job.episodes % 200 === 0) log("generate episodes", job.episodes);
    }
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
          episodes: job.episodes,
          channels: job.channels,
        },
        null,
        2,
      ),
    );
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
  const cine = await waitUp("cinepro", config.cineproUrl);
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
    log("bootstrap: STRM already generated");
    return;
  } catch {
    /* first run */
  }
  log("bootstrap first-run STRM", "moviePages=" + config.moviePages, "tvPages=" + config.tvPages);
  generateLibrary().then(() => {
    log("bootstrap done movies=" + job.movies, "episodes=" + job.episodes, "live=" + job.channels);
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
    },
    generateOnStart: config.generateOnStart,
    qualityFallback: config.qualityFallback,
  };
}
