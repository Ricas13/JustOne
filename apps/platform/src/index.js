import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";
import {
  resolveMovie,
  resolveEpisode,
  resolveLive,
  cacheStats,
} from "./resolve.js";
import { slugTvgId } from "./naming.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const TMDB = "https://api.themoviedb.org/3";
const STREMIO_UPSTREAM = (process.env.STREMIO_UPSTREAM || "http://stremio-addon:7000").replace(/\/$/, "");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("x-justone", "platform");
  next();
});
app.use(express.static(publicDir, { index: "index.html" }));

function redirectTo(res, url, format) {
  if (!url) return res.status(502).json({ error: "no source" });
  if (format === "json") return res.json({ url, mode: "redirect" });
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, url);
}

function proxyStremio(req, res) {
  const target = new URL(req.originalUrl, STREMIO_UPSTREAM);
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  const p = http.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  p.on("error", (e) => {
    res.status(502).json({ error: "stremio upstream", detail: String(e.message || e) });
  });
  req.pipe(p);
}

async function tmdb(pathname, params = {}) {
  if (!config.tmdbKey) return null;
  const url = new URL(TMDB + pathname);
  url.searchParams.set("api_key", config.tmdbKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  return r.json();
}

app.get("/health", async (_req, res) => {
  const checks = {};
  for (const [name, url] of [
    ["cinepro", config.cineproUrl],
    ["dlhd", config.dlhdUrl],
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      checks[name] = { ok: r.ok || r.status < 500, status: r.status };
    } catch (e) {
      checks[name] = { ok: false, error: String(e.message || e) };
    }
  }
  res.json({
    service: "justone-platform",
    mode: "redirect-resolver",
    publicUrl: config.publicUrl,
    cache: cacheStats(),
    checks,
  });
});

app.get("/resolve/movie/:tmdbId", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const url = await resolveMovie(req.params.tmdbId, quality);
    return redirectTo(res, url, req.query.format);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/resolve/episode/:tmdbId/:season/:episode", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const url = await resolveEpisode(
      req.params.tmdbId,
      req.params.season,
      req.params.episode,
      quality,
    );
    return redirectTo(res, url, req.query.format);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/resolve/live/:channelId", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const url = await resolveLive(req.params.channelId, { force });
    return redirectTo(res, url, req.query.format);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

let channelCache = { at: 0, list: [] };

async function loadChannels(force = false) {
  const stale = Date.now() - channelCache.at > config.liveRefreshMin * 60 * 1000;
  if (!force && channelCache.list.length && !stale) return channelCache.list;
  const r = await fetch(`${config.dlhdUrl}/api/channels`, {
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  const list = Array.isArray(data) ? data : data.channels || [];
  channelCache = { at: Date.now(), list };
  return list;
}

app.get("/live/channels", async (_req, res) => {
  try {
    res.json(await loadChannels());
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/live/playlist.m3u8", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const list = await loadChannels(force);
    const lines = [`#EXTM3U url-tvg="${config.epgUrl}" tvg-shift=0`];
    list.forEach((ch, i) => {
      const name = ch.name || `Channel ${ch.id}`;
      const tvg = slugTvgId(name);
      const logo = ch.logo || "";
      const group = ch.group || ch.category || "Live";
      lines.push(
        `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${i + 1}" group-title="${group}",${name}`,
      );
      lines.push(`${config.publicUrl}/resolve/live/${ch.id}`);
    });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(lines.join("\n") + "\n");
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.post("/live/refresh", async (_req, res) => {
  try {
    const list = await loadChannels(true);
    res.json({ ok: true, count: list.length });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post("/library/movie", async (req, res) => {
  try {
    const { title, year, tmdbId, qualities } = req.body || {};
    if (!title || !tmdbId) return res.status(400).json({ error: "title and tmdbId required" });
    const qs = qualities?.length ? qualities : config.qualities;
    const written = [];
    for (const quality of qs) {
      written.push(await writeMovieStrm({ title, year, tmdbId, quality }));
    }
    res.json({ ok: true, written });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/library/episode", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.showTitle || !body.tmdbId || body.season == null || body.episode == null) {
      return res.status(400).json({ error: "showTitle, tmdbId, season, episode required" });
    }
    const qs = body.qualities?.length ? body.qualities : config.qualities;
    const written = [];
    for (const quality of qs) {
      written.push(await writeEpisodeStrm({ ...body, quality }));
    }
    res.json({ ok: true, written });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/library/generate", async (req, res) => {
  try {
    const moviePages = Math.min(Number(req.body?.moviePages || 0), 50);
    const tvPages = Math.min(Number(req.body?.tvPages || 0), 20);
    const maxEpisodes = Math.min(Number(req.body?.maxEpisodes || 12), 40);
    const qs = config.qualities;
    let movies = 0;
    let episodes = 0;
    for (let page = 1; page <= moviePages; page++) {
      const data = await tmdb("/trending/movie/week", { page });
      for (const m of data?.results || []) {
        const year = Number(String(m.release_date || "").slice(0, 4)) || 0;
        for (const quality of qs) {
          await writeMovieStrm({ title: m.title, year, tmdbId: m.id, quality });
          movies += 1;
        }
      }
    }
    for (let page = 1; page <= tvPages; page++) {
      const data = await tmdb("/trending/tv/week", { page });
      for (const s of data?.results || []) {
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
            episodes += 1;
          }
        }
      }
    }
    res.json({ ok: true, movies, episodes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.use("/stremio", proxyStremio);

function sendIndex(_req, res) {
  res.sendFile(path.join(publicDir, "index.html"));
}
app.get("/", sendIndex);
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/resolve") ||
    req.path.startsWith("/live") ||
    req.path.startsWith("/library") ||
    req.path.startsWith("/health") ||
    req.path.startsWith("/stremio")
  ) {
    return next();
  }
  sendIndex(req, res);
});

setInterval(() => {
  loadChannels(true).catch(() => {});
}, Math.max(config.liveRefreshMin, 5) * 60 * 1000).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  console.log(`JustOne platform on :${config.port} (redirect resolver)`);
});
