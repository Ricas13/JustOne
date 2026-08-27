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
import {
  loadChannels,
  buildM3u,
  writeLivePlaylist,
  generateLibrary,
  bootstrap,
  libraryStatus,
  job,
} from "./generate.js";
import {
  playMoviePath,
  playEpisodePath,
  playLivePath,
  publicPlayUrl,
  movieDownloadFilename,
  episodeDownloadFilename,
  proxyStream,
} from "./play.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const STREMIO_UPSTREAM = (process.env.STREMIO_UPSTREAM || "http://stremio-addon:7000").replace(
  /\/$/,
  "",
);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("x-justone", "platform");
  next();
});
app.use(express.static(publicDir, { index: "index.html" }));

function redirectTo(res, picked, format, playPath) {
  if (!picked?.url) {
    return res.status(404).json({
      error: "no source",
      wanted: picked?.wanted,
      available: picked?.available || [],
    });
  }
  const opaque = publicPlayUrl(playPath);
  res.setHeader("x-justone-quality", picked.quality || "");
  res.setHeader("x-justone-wanted", picked.wanted || "");
  res.setHeader("x-justone-matched", picked.matched ? "1" : "0");
  if (format === "json") {
    return res.json({
      url: opaque,
      mode: "play",
      quality: picked.quality,
      wanted: picked.wanted,
      matched: picked.matched,
      available: picked.available,
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, opaque);
}

function proxyTo(base) {
  return (req, res) => {
    const target = new URL(req.url, base.endsWith("/") ? base : base + "/");
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    delete headers["content-length"];
    const p = http.request(
      target,
      { method: req.method, headers, timeout: 120000 },
      (up) => {
        const out = { ...up.headers };
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      },
    );
    p.on("error", (e) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "upstream", detail: String(e.message || e) });
      } else {
        res.destroy();
      }
    });
    req.pipe(p);
  };
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
    library: libraryStatus(),
    checks,
  });
});

app.get("/resolve/movie/:tmdbId", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const picked = await resolveMovie(req.params.tmdbId, quality);
    return redirectTo(res, picked, req.query.format, playMoviePath(req.params.tmdbId, quality));
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/resolve/episode/:tmdbId/:season/:episode", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const picked = await resolveEpisode(
      req.params.tmdbId,
      req.params.season,
      req.params.episode,
      quality,
    );
    return redirectTo(
      res,
      picked,
      req.query.format,
      playEpisodePath(req.params.tmdbId, req.params.season, req.params.episode, quality),
    );
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/resolve/live/:channelId", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    const picked = await resolveLive(req.params.channelId, { force });
    return redirectTo(res, picked, req.query.format, playLivePath(req.params.channelId));
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

function extOf(picked) {
  const t = String(picked?.type || picked?.url || "").toLowerCase();
  if (t.includes("m3u8") || t.includes("hls")) return "m3u8";
  if (t.includes("webm")) return "webm";
  if (t.includes("mkv")) return "mkv";
  return "mp4";
}

app.get("/play/movie/:tmdbId", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const picked = await resolveMovie(req.params.tmdbId, quality);
    if (!picked?.url) return redirectTo(res, picked, "json", playMoviePath(req.params.tmdbId, quality));
    const filename = await movieDownloadFilename(req.params.tmdbId, extOf(picked));
    proxyStream(req, res, picked.url, { filename, download: req.query.download === "1" });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/play/episode/:tmdbId/:season/:episode", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const picked = await resolveEpisode(
      req.params.tmdbId,
      req.params.season,
      req.params.episode,
      quality,
    );
    if (!picked?.url) {
      return redirectTo(
        res,
        picked,
        "json",
        playEpisodePath(req.params.tmdbId, req.params.season, req.params.episode, quality),
      );
    }
    const filename = await episodeDownloadFilename(
      req.params.tmdbId,
      req.params.season,
      req.params.episode,
      extOf(picked),
    );
    proxyStream(req, res, picked.url, { filename, download: req.query.download === "1" });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/play/live/:channelId", async (req, res) => {
  try {
    const picked = await resolveLive(req.params.channelId, { force: req.query.refresh === "1" });
    if (!picked?.url) return redirectTo(res, picked, "json", playLivePath(req.params.channelId));
    const filename = `live-${req.params.channelId}.m3u8`;
    proxyStream(req, res, picked.url, { filename, download: req.query.download === "1" });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

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
    const body = buildM3u(list);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(body);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.post("/live/refresh", async (_req, res) => {
  try {
    const out = await writeLivePlaylist(true);
    res.json({ ok: true, count: out.count, file: out.file });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/library/status", (_req, res) => res.json(libraryStatus()));

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

app.post("/library/generate", (req, res) => {
  if (job.running) return res.status(409).json({ error: "already running", ...libraryStatus() });
  const moviePages = Math.min(Number(req.body?.moviePages || config.moviePages), 40);
  const tvPages = Math.min(Number(req.body?.tvPages || config.tvPages), 30);
  const maxEpisodes = Math.min(Number(req.body?.maxEpisodes || config.tvMaxEpisodes), 40);
  generateLibrary({ moviePages, tvPages, maxEpisodes });
  res.status(202).json({ ok: true, started: true, ...libraryStatus() });
});

app.use("/cinepro", proxyTo(config.cineproUrl));
app.use("/stremio", proxyTo(STREMIO_UPSTREAM));

function sendIndex(_req, res) {
  res.sendFile(path.join(publicDir, "index.html"));
}
app.get("/", sendIndex);
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/play") ||
    req.path.startsWith("/resolve") ||
    req.path.startsWith("/live") ||
    req.path.startsWith("/library") ||
    req.path.startsWith("/health") ||
    req.path.startsWith("/cinepro") ||
    req.path.startsWith("/stremio")
  ) {
    return next();
  }
  sendIndex(req, res);
});

setInterval(() => {
  writeLivePlaylist(true).catch(() => {});
}, Math.max(config.liveRefreshMin, 5) * 60 * 1000).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`JustOne platform on :${config.port} (redirect resolver)\n`);
  bootstrap().catch((e) => process.stdout.write("bootstrap " + String(e) + "\n"));
});
