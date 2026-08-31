import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, withKey } from "./config.js";
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
  filterChannels,
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
  proxyHlsToken,
  fixMediaType,
  restreamMpegTs,
} from "./play.js";
import { isAuthed, isPublicPath, isStreamPath, hasPlaylistKey, setAuthCookie, clearAuthCookie } from "./auth.js";
import { readSources, writeSources, getExtChannel, loadAllExtra } from "./sources.js";
import {
  startAutoUpdater,
  triggerProviderUpdate,
  getAutoUpdaterStatus,
} from "./services/autoUpdater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const STREMIO_UPSTREAM = (process.env.STREMIO_UPSTREAM || "http://stremio-addon:7000").replace(
  /\/$/,
  "",
);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("x-justone", "platform");
  next();
});
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (isPublicPath(req.path)) {
    if (isStreamPath(req.path) && !hasPlaylistKey(req)) {
      return res.status(401).json({ error: "key required" });
    }
    return next();
  }
  if (isAuthed(req)) return next();
  if (
    req.path === "/" ||
    req.path.endsWith(".html") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".css")
  ) {
    return res.redirect("/login");
  }
  return res.status(401).json({ error: "auth required" });
});
app.use(express.static(publicDir, { index: false }));

function redirectTo(res, picked, format, playPath) {
  if (!picked?.url) {
    const providerErrors = picked?.providerErrors || null;
    const reason =
      picked?.playbackFailure ||
      (providerErrors?.primary || providerErrors?.secondary
        ? "provider-error"
        : picked?.available?.length
          ? "no-working-source"
          : "no-candidates");
    return res.status(404).json({
      error: "no source",
      reason,
      wanted: picked?.wanted,
      available: picked?.available || [],
      matched: Boolean(picked?.matched),
      validated: Boolean(picked?.validated),
      playbackValidated: Boolean(picked?.playbackValidated),
      failoverAttempts: Number(picked?.failoverAttempts || 0),
      providerErrors,
      diagnostics: Array.isArray(picked?.diagnostics) ? picked.diagnostics : [],
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
      validated: Boolean(picked.validated),
      playbackValidated: Boolean(picked.playbackValidated),
      failoverAttempts: Number(picked.failoverAttempts || 0),
      resolver: picked.resolver || null,
      provider: picked.provider || null,
      available: picked.available,
      providerErrors: picked.providerErrors || null,
      diagnostics: Array.isArray(picked.diagnostics) ? picked.diagnostics : [],
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, opaque);
}

function proxyTo(base) {
  return (req, res) => {
    const root = base.endsWith("/") ? base : `${base}/`;
    const rel = (req.url.startsWith("/") ? req.url.slice(1) : req.url) || "";
    const target = new URL(rel, root);
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    delete headers["content-length"];
    const p = http.request(
      target,
      { method: req.method === "HEAD" ? "GET" : req.method, headers, timeout: 120000 },
      (up) => {
        const out = fixMediaType({ ...up.headers }, target.href);
        delete out.location;
        delete out.Location;
        res.writeHead(up.statusCode || 502, out);
        if (req.method === "HEAD") {
          up.resume();
          res.end();
          return;
        }
        up.pipe(res);
      },
    );
    p.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "upstream" });
      else res.destroy();
    });
    if (req.method === "HEAD") p.end();
    else req.pipe(p);
  };
}

function proxyOriginal(base) {
  return (req, res) => {
    const target = new URL(req.originalUrl, base.endsWith("/") ? base : `${base}/`);
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    headers["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const p = http.request(
      target,
      { method: req.method === "HEAD" ? "GET" : req.method, headers, timeout: 120000 },
      (up) => {
        const out = fixMediaType({ ...up.headers }, req.originalUrl);
        delete out.location;
        delete out.Location;
        res.writeHead(up.statusCode || 502, out);
        if (req.method === "HEAD") {
          up.resume();
          res.end();
          return;
        }
        up.pipe(res);
      },
    );
    p.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "upstream" });
      else res.destroy();
    });
    if (req.method === "HEAD") p.end();
    else req.pipe(p);
  };
}

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});
app.post("/login", (req, res) => {
  const pass = String(req.body?.password || req.body?.pass || "");
  if (!config.adminPassword) return res.redirect("/");
  if (pass && pass === config.adminPassword) {
    setAuthCookie(res);
    return res.redirect("/");
  }
  res.redirect("/login?e=1");
});
app.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.redirect("/login");
});

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
    const id = String(req.params.channelId).replace(/\.(m3u8|ts)$/i, "");
    const picked = await resolveLive(id, { force: req.query.refresh === "1" });
    return redirectTo(res, picked, req.query.format, playLivePath(id));
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

app.get("/play/hls/:token", (req, res) => {
  proxyHlsToken(req, res, req.params.token);
});

app.get("/play/movie/:tmdbId", async (req, res) => {
  try {
    const quality = req.query.quality === "4k" ? "4k" : "1080p";
    const picked = await resolveMovie(req.params.tmdbId, quality);
    if (!picked?.url) return redirectTo(res, picked, "json", playMoviePath(req.params.tmdbId, quality));
    const ext = extOf(picked);
    const filename = await movieDownloadFilename(req.params.tmdbId, ext);
    proxyStream(req, res, picked.url, {
      filename,
      download: req.query.download === "1",
      upstreamHeaders: picked.requestHeaders || {},
      hls: ext === "m3u8",
    });
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
    const ext = extOf(picked);
    const filename = await episodeDownloadFilename(
      req.params.tmdbId,
      req.params.season,
      req.params.episode,
      ext,
    );
    proxyStream(req, res, picked.url, {
      filename,
      download: req.query.download === "1",
      upstreamHeaders: picked.requestHeaders || {},
      hls: ext === "m3u8",
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/play/live/:channelId", async (req, res) => {
  try {
    const raw = String(req.params.channelId);
    const asTs = /\.ts$/i.test(raw) || req.query.fmt === "ts";
    const id = raw.replace(/\.(m3u8|ts)$/i, "");
    const picked = await resolveLive(id, { force: req.query.refresh === "1" });
    if (!picked?.url) return redirectTo(res, picked, "json", playLivePath(id));
    if (asTs) {
      if (req.method === "HEAD") {
        res.setHeader("Content-Type", "video/mp2t");
        return res.status(200).end();
      }
      const hls = `http://127.0.0.1:${config.port}/play/live/${id}.m3u8`;
      return restreamMpegTs(req, res, hls);
    }
    proxyStream(req, res, picked.url, { filename: null, download: false });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/play/ext/:id", async (req, res) => {
  try {
    let ch = getExtChannel(req.params.id);
    if (!ch) {
      await loadAllExtra();
      ch = getExtChannel(req.params.id);
    }
    if (!ch?.url) return res.status(404).json({ error: "no source" });
    proxyStream(req, res, ch.url, { filename: null, download: false });
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

app.get("/live/playlist.m3u8", (req, res) => sendPlaylist(req, res, req.query.kind || "all"));
app.get("/live/247.m3u8", (req, res) => sendPlaylist(req, res, "247"));
app.get("/live/sports.m3u8", (req, res) => sendPlaylist(req, res, "sports"));
app.get("/live/extra.m3u8", (req, res) => sendPlaylist(req, res, "extra"));

async function sendPlaylist(req, res, kind) {
  try {
    const list = await loadChannels(req.query.refresh === "1");
    let rows = filterChannels(list, kind);
    const country = String(req.query.country || "").trim();
    if (country) {
      rows = rows.filter((c) => String(c.group || "").toLowerCase() === country.toLowerCase());
    }
    const body = buildM3u(rows, kind === "all" && !country ? "all" : kind);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(body);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
}

app.post("/live/refresh", async (_req, res) => {
  try {
    const out = await writeLivePlaylist(true);
    res.json({ ok: true, count: out.count, file: out.file });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/live/links", (_req, res) => {
  const base = config.publicUrl;
  res.json({
    locked: Boolean(config.playlistKey),
    all: withKey(`${base}/live/playlist.m3u8`),
    tv: withKey(`${base}/live/247.m3u8`),
    sports: withKey(`${base}/live/sports.m3u8`),
    extra: withKey(`${base}/live/extra.m3u8`),
  });
});

app.get("/live/sources", async (_req, res) => {
  res.json(await readSources());
});

app.post("/live/sources", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    if (!name || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "name and http(s) url required" });
    }
    const list = await readSources();
    const id = String(req.body?.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 40);
    const next = list.filter((s) => s.id !== id);
    next.push({ id, name, url, enabled: req.body?.enabled !== false });
    await writeSources(next);
    res.json({ ok: true, sources: next });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/live/sources/delete", async (req, res) => {
  const id = String(req.body?.id || "");
  const next = (await readSources()).filter((s) => s.id !== id);
  await writeSources(next);
  res.json({ ok: true, sources: next });
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
  const moviePages = Math.min(Number(req.body?.moviePages || config.moviePages), 50);
  const tvPages = Math.min(Number(req.body?.tvPages || config.tvPages), 40);
  const maxEpisodes = Math.min(Number(req.body?.maxEpisodes || config.tvMaxEpisodes), 40);
  generateLibrary({ moviePages, tvPages, maxEpisodes });
  res.status(202).json({ ok: true, started: true, ...libraryStatus() });
});

app.get("/api/update-providers/status", (_req, res) => {
  res.json(getAutoUpdaterStatus());
});

app.post("/api/update-providers", (_req, res) => {
  if (!config.adminPassword) {
    return res.status(503).json({
      error: "ADMIN_PASSWORD must be configured before manual provider updates are allowed",
    });
  }

  const result = triggerProviderUpdate("manual");
  if (!result.started) {
    return res.status(409).json({ ok: false, ...result, updater: getAutoUpdaterStatus() });
  }
  return res.status(202).json({
    ok: true,
    ...result,
    message: "source resolver update check started; progress is written to platform logs",
  });
});

app.use("/cinepro", proxyTo(config.cineproUrl));
app.use("/stremio", proxyTo(STREMIO_UPSTREAM));
app.use("/api/proxy", proxyOriginal(config.dlhdUrl));
app.use("/api/stream", proxyOriginal(config.dlhdUrl));

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
    req.path.startsWith("/stremio") ||
    req.path.startsWith("/api") ||
    req.path.startsWith("/login")
  ) {
    return next();
  }
  sendIndex(req, res);
});

function catalogTick() {
  process.stdout.write("scheduled refresh: live + tmdb\n");
  writeLivePlaylist(true)
    .then((out) => process.stdout.write("scheduled live " + out.count + "\n"))
    .catch((e) => process.stdout.write("scheduled live fail " + String(e.message || e) + "\n"));
  if (job.running) {
    process.stdout.write("scheduled tmdb skipped (already running)\n");
    return;
  }
  generateLibrary().catch((e) => process.stdout.write("scheduled tmdb fail " + String(e.message || e) + "\n"));
}

const catalogMs = Math.max(config.catalogRefreshHours, 1) * 60 * 60 * 1000;
setInterval(catalogTick, catalogMs).unref?.();
process.stdout.write(`catalog refresh every ${config.catalogRefreshHours}h\n`);

app.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`JustOne platform on :${config.port} (redirect resolver)\n`);
  if (!config.adminPassword) process.stdout.write("WARN: ADMIN_PASSWORD is empty — dashboard is open\n");
  bootstrap().catch((e) => process.stdout.write("bootstrap " + String(e) + "\n"));
  startAutoUpdater();
});
