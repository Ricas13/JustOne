import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";
import { slugTvgId } from "./naming.js";

const TMDB = "https://api.themoviedb.org/3";

export const job = {
  running: false,
  phase: "idle",
  movies: 0,
  episodes: 0,
  channels: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tmdb(pathname, params = {}) {
  if (!config.tmdbKey) return null;
  const url = new URL(TMDB + pathname);
  url.searchParams.set("api_key", config.tmdbKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  await sleep(280);
  return r.json();
}

let channelCache = { at: 0, list: [] };

export async function loadChannels(force = false) {
  const stale = Date.now() - channelCache.at > config.liveRefreshMin * 60 * 1000;
  if (!force && channelCache.list.length && !stale) return channelCache.list;
  const r = await fetch(`${config.dlhdUrl}/api/channels`, {
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  const list = Array.isArray(data) ? data : data.channels || data.items || [];
  channelCache = { at: Date.now(), list };
  return list;
}

export function buildM3u(list) {
  const lines = [`#EXTM3U url-tvg="${config.epgUrl}" tvg-shift=0`];
  list.forEach((ch, i) => {
    const name = String(ch.name || `Channel ${ch.id}`).replace(/[\r\n"]/g, " ");
    const tvg = slugTvgId(name) || `dlhd-${ch.id}`;
    const logo = ch.logo || ch.image || "";
    const group = ch.group || ch.category || "Live";
    lines.push(
      `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${i + 1}" group-title="${group}",${name}`,
    );
    lines.push(`${config.publicUrl}/resolve/live/${ch.id}`);
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
  const lists = ["/trending/movie/week", "/movie/popular", "/movie/top_rated"];
  for (const endpoint of lists) {
    for (let page = 1; page <= pages; page++) {
      const data = await tmdb(endpoint, { page });
      for (const m of data?.results || []) {
        if (m?.id && !seen.has(m.id)) seen.set(m.id, m);
      }
    }
  }
  return [...seen.values()];
}

async function uniqueShows(pages) {
  const seen = new Map();
  const lists = ["/trending/tv/week", "/tv/popular"];
  for (const endpoint of lists) {
    for (let page = 1; page <= pages; page++) {
      const data = await tmdb(endpoint, { page });
      for (const s of data?.results || []) {
        if (s?.id && !seen.has(s.id)) seen.set(s.id, s);
      }
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
    const movies = await uniqueMovies(Math.min(moviePages, 40));
    for (const m of movies) {
      const year = Number(String(m.release_date || "").slice(0, 4)) || 0;
      for (const quality of qs) {
        await writeMovieStrm({ title: m.title, year, tmdbId: m.id, quality });
        job.movies += 1;
      }
    }
    job.phase = "tv";
    const shows = await uniqueShows(Math.min(tvPages, 30));
    for (const s of shows) {
      const year = Number(String(s.first_air_date || "").slice(0, 4)) || 0;
      const detail = await tmdb(`/tv/${s.id}`, { append_to_response: "external_ids" });
      const tvdbId = detail?.external_ids?.tvdb_id;
      const season = (detail?.seasons || []).find((x) => x.season_number === 1);
      const count = Math.min(season?.episode_count || maxEpisodes, maxEpisodes);
      for (let ep = 1; ep <= count; ep++) {
        for (const quality of qs) {
          await writeEpisodeStrm({
            showTitle: s.name,
            year,
            tmdbId: s.id,
            tvdbId,
            season: 1,
            episode: ep,
            quality,
          });
          job.episodes += 1;
        }
      }
    }
    job.phase = "live";
    await writeLivePlaylist(true);
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
    console.error("generate failed", e);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
  return job;
}

async function waitUp(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok || r.status < 500) return true;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  return false;
}

export async function bootstrap() {
  console.log("bootstrap: waiting for cinepro + dlhd");
  await waitUp(config.cineproUrl);
  await waitUp(`${config.dlhdUrl}/api/channels`);
  try {
    const live = await writeLivePlaylist(true);
    console.log(`bootstrap: live m3u ${live.count} channels → ${live.file}`);
  } catch (e) {
    console.error("bootstrap live failed", e);
  }
  if (!config.generateOnStart) return;
  if (!config.tmdbKey) {
    console.warn("bootstrap: no TMDB_API_KEY, skip STRM");
    return;
  }
  const marker = path.join(config.liveDir, ".justone-first-run.json");
  try {
    await fs.access(marker);
    console.log("bootstrap: STRM already generated, skip (POST /library/generate to redo)");
    return;
  } catch {
    /* first run */
  }
  console.log(
    `bootstrap: first-run STRM movies×${config.moviePages} pages, tv×${config.tvPages} pages`,
  );
  generateLibrary().then(() => {
    console.log(`bootstrap done movies=${job.movies} episodes=${job.episodes} live=${job.channels}`);
  });
}

export function libraryStatus() {
  return {
    ...job,
    paths: {
      movies1080: config.movies1080,
      movies4k: config.movies4k,
      tv1080: config.tv1080,
      tv4k: config.tv4k,
      live: config.liveDir,
    },
    generateOnStart: config.generateOnStart,
  };
}
