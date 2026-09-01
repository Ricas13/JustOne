import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, withKey } from "./config.js";
import { resolveLive, cacheStats } from "./resolve.js";
import {
  loadChannels,
  buildM3u,
  filterChannels,
  writeLivePlaylist,
  bootstrap,
  liveStatus,
  startLiveRefresh,
} from "./generate.js";
import {
  playLivePath,
  publicPlayUrl,
  proxyStream,
  proxyHlsToken,
  fixMediaType,
  restreamMpegTs,
} from "./play.js";
import {
  isAuthed,
  isPublicPath,
  isStreamPath,
  hasPlaylistKey,
  setAuthCookie,
  clearAuthCookie,
} from "./auth.js";
import { readSources, writeSources, getExtChannel, loadAllExtra } from "./sources.js";
import { activeStreamStats, beginLiveStream } from "./liveStreams.js";

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
  if (!picked?.url) return res.status(404).json({ error: "no live source" });

  const opaque = publicPlayUrl(playPath);
  res.setHeader("x-justone-quality", "live");
  res.setHeader("x-justone-provider", picked.provider || "");
  if (format === "json") {
    return res.json({
      url: opaque,
      mode: "play",
      quality: "live",
      validated: Boolean(picked.validated),
      playbackValidated: Boolean(picked.playbackValidated),
      provider: picked.provider || null,
      available: ["live"],
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
    const request = http.request(
      target,
      { method: req.method === "HEAD" ? "GET" : req.method, headers, timeout: 120000 },
      (upstream) => {
        const out = fixMediaType({ ...upstream.headers }, target.href);
        delete out.location;
        delete out.Location;
        res.writeHead(upstream.statusCode || 502, out);
        if (req.method === "HEAD") {
          upstream.resume();
          res.end();
          return;
        }
        upstream.pipe(res);
      },
    );
    request.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "upstream" });
      else res.destroy();
    });
    if (req.method === "HEAD") request.end();
    else req.pipe(request);
  };
}

function proxyOriginal(base) {
  return (req, res) => {
    const target = new URL(req.originalUrl, base.endsWith("/") ? base : `${base}/`);
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    headers["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const request = http.request(
      target,
      { method: req.method === "HEAD" ? "GET" : req.method, headers, timeout: 120000 },
      (upstream) => {
        const out = fixMediaType({ ...upstream.headers }, req.originalUrl);
        delete out.location;
        delete out.Location;
        res.writeHead(upstream.statusCode || 502, out);
        if (req.method === "HEAD") {
          upstream.resume();
          res.end();
          return;
        }
        upstream.pipe(res);
      },
    );
    request.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "upstream" });
      else res.destroy();
    });
    if (req.method === "HEAD") request.end();
    else req.pipe(request);
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
    ["dlhdProxy", config.dlhdProxyUrl],
    ["dlhd", config.dlhdUrl],
  ]) {
    if (!url) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      checks[name] = { ok: response.ok || response.status < 500, status: response.status };
    } catch (error) {
      checks[name] = { ok: false, error: String(error.message || error) };
    }
  }
  res.json({
    service: "justone-platform",
    mode: "live-tv",
    publicUrl: config.publicUrl,
    cache: cacheStats(),
    live: liveStatus(),
    streams: activeStreamStats(),
    checks,
  });
});

app.get("/resolve/live/:channelId", async (req, res) => {
  try {
    const id = String(req.params.channelId).replace(/\.(m3u8|ts)$/i, "");
    const picked = await resolveLive(id, { force: req.query.refresh === "1" });
    return redirectTo(res, picked, req.query.format, playLivePath(id));
  } catch (error) {
    res.status(502).send(String(error.message || error));
  }
});

app.get("/play/hls/:token", (req, res) => {
  proxyHlsToken(req, res, req.params.token);
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
      const stream = beginLiveStream({
        channelId: id,
        provider: picked.provider,
        userAgent: req.headers["user-agent"],
      });
      try {
        await restreamMpegTs(req, res, hls);
      } finally {
        stream.end();
      }
      return;
    }
    proxyStream(req, res, picked.url, { filename: null, download: false });
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/play/ext/:id", async (req, res) => {
  try {
    let channel = getExtChannel(req.params.id);
    if (!channel) {
      await loadAllExtra();
      channel = getExtChannel(req.params.id);
    }
    if (!channel?.url) return res.status(404).json({ error: "no source" });
    proxyStream(req, res, channel.url, { filename: null, download: false });
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: "play failed" });
  }
});

app.get("/live/channels", async (_req, res) => {
  try {
    res.json(await loadChannels());
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/live/status", (_req, res) => res.json(liveStatus()));
app.get("/live/streams", (_req, res) => res.json(activeStreamStats()));
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
      rows = rows.filter((channel) => String(channel.group || "").toLowerCase() === country.toLowerCase());
    }
    const body = buildM3u(rows, kind === "all" && !country ? "all" : kind);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(body);
  } catch (error) {
    res.status(502).send(String(error.message || error));
  }
}

app.post("/live/refresh", async (_req, res) => {
  try {
    const out = await writeLivePlaylist(true);
    res.json({ ok: true, count: out.count, file: out.file });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
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
    const next = list.filter((source) => source.id !== id);
    next.push({ id, name, url, enabled: req.body?.enabled !== false });
    await writeSources(next);
    res.json({ ok: true, sources: next });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/live/sources/delete", async (req, res) => {
  const id = String(req.body?.id || "");
  const next = (await readSources()).filter((source) => source.id !== id);
  await writeSources(next);
  res.json({ ok: true, sources: next });
});

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
    req.path.startsWith("/health") ||
    req.path.startsWith("/stremio") ||
    req.path.startsWith("/api") ||
    req.path.startsWith("/login")
  ) {
    return next();
  }
  sendIndex(req, res);
});

app.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`JustOne platform on :${config.port} (Live TV only)\n`);
  if (!config.adminPassword) process.stdout.write("WARN: ADMIN_PASSWORD is empty — dashboard is open\n");
  bootstrap().catch((error) => process.stdout.write("bootstrap " + String(error) + "\n"));
  startLiveRefresh();
});