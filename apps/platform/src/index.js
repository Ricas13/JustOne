import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, publicizeStreamUrl } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});
app.use(express.static(publicDir));

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
    publicUrl: config.publicUrl,
    cineproPublicUrl: config.cineproPublicUrl,
    checks,
  });
});

const unifiedManifest = {
  id: "com.justone.addon",
  version: "1.0.0",
  name: "JustOne",
  description: "Movies, series, and live TV from your personal JustOne hub.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  catalogs: [
    { type: "movie", id: "justone-movies", name: "JustOne Movies" },
    { type: "series", id: "justone-series", name: "JustOne Series" },
    { type: "tv", id: "justone-live", name: "JustOne Live TV" },
  ],
  idPrefixes: ["tmdb:", "justone_live_"],
  behaviorHints: { configurable: false, configurationRequired: false },
};

app.get("/stremio/manifest.json", (_req, res) => {
  res.json(unifiedManifest);
});

app.get("/proxy/vod", async (req, res) => {
  let target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).send("url query required");
  }
  target = publicizeStreamUrl(target);
  res.redirect(302, target);
});

app.get("/proxy/live/:channelId", async (req, res) => {
  const id = req.params.channelId;
  const upstream = `${config.dlhdUrl}/api/stream/${id}.m3u8`;
  res.redirect(302, upstream);
});

app.get("/live/playlist.m3u8", async (_req, res) => {
  try {
    const r = await fetch(`${config.dlhdUrl}/playlist.m3u8`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      return res.status(502).send(`live playlist error: ${r.status}`);
    }
    let text = await r.text();
    text = text.replace(
      /https?:\/\/[^\s]+\/api\/stream\/(\d+)\.m3u8/g,
      `${config.publicUrl}/proxy/live/$1`,
    );
    text = text.replace(
      /(?:^|\n)(\/api\/stream\/(\d+)\.m3u8)/g,
      `\n${config.publicUrl}/proxy/live/$2`,
    );
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(text);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.post("/library/movie", async (req, res) => {
  try {
    const { title, year, streamUrl, tmdbId } = req.body || {};
    if (!title || !streamUrl) {
      return res.status(400).json({ error: "title and streamUrl required" });
    }
    const result = await writeMovieStrm({ title, year, streamUrl, tmdbId });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/library/episode", async (req, res) => {
  try {
    const { showTitle, season, episode, episodeTitle, streamUrl, tmdbId } = req.body || {};
    if (!showTitle || season == null || episode == null || !streamUrl) {
      return res.status(400).json({
        error: "showTitle, season, episode, streamUrl required",
      });
    }
    const result = await writeEpisodeStrm({
      showTitle,
      season,
      episode,
      episodeTitle,
      streamUrl,
      tmdbId,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function extractSources(data) {
  if (!data) return [];
  if (Array.isArray(data.sources)) return data.sources;
  if (Array.isArray(data.streams)) return data.streams;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function sourceUrl(s) {
  if (!s) return null;
  if (typeof s === "string") return s;
  return s.url || s.src || s.stream || s.file || null;
}

app.post("/resolve/movie", async (req, res) => {
  try {
    const { tmdbId, title, year, writeStrm = false } = req.body || {};
    if (!tmdbId) {
      return res.status(400).json({ error: "tmdbId required" });
    }
    const pathUrl = `${config.cineproUrl}/v1/movies/${tmdbId}`;
    const r = await fetch(pathUrl, { signal: AbortSignal.timeout(90000) });
    const body = await r.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return res.status(502).json({
        error: "cinepro non-json response",
        status: r.status,
        preview: body.slice(0, 400),
      });
    }
    if (!r.ok) {
      return res.status(502).json({ error: "cinepro error", status: r.status, data });
    }

    const sources = extractSources(data).map((s) => {
      if (s && typeof s === "object" && s.url) {
        return { ...s, url: publicizeStreamUrl(s.url) };
      }
      return s;
    });
    let strm = null;
    if (writeStrm && sources.length && title) {
      const stream = sourceUrl(sources[0]);
      if (stream) {
        strm = await writeMovieStrm({ title, year, streamUrl: stream, tmdbId });
      }
    }
    res.json({ ok: true, path: pathUrl, sources, strm });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/resolve/episode", async (req, res) => {
  try {
    const {
      tmdbId,
      season,
      episode,
      showTitle,
      episodeTitle,
      writeStrm = false,
    } = req.body || {};
    if (!tmdbId || season == null || episode == null) {
      return res.status(400).json({ error: "tmdbId, season, episode required" });
    }
    const pathUrl = `${config.cineproUrl}/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`;
    const r = await fetch(pathUrl, { signal: AbortSignal.timeout(90000) });
    const body = await r.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return res.status(502).json({
        error: "cinepro non-json response",
        status: r.status,
        preview: body.slice(0, 400),
      });
    }
    if (!r.ok) {
      return res.status(502).json({ error: "cinepro error", status: r.status, data });
    }

    const sources = extractSources(data).map((s) => {
      if (s && typeof s === "object" && s.url) {
        return { ...s, url: publicizeStreamUrl(s.url) };
      }
      return s;
    });
    let strm = null;
    if (writeStrm && sources.length && showTitle) {
      const stream = sourceUrl(sources[0]);
      if (stream) {
        strm = await writeEpisodeStrm({
          showTitle,
          season,
          episode,
          episodeTitle,
          streamUrl: stream,
          tmdbId,
        });
      }
    }
    res.json({ ok: true, path: pathUrl, sources, strm });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/live/channels", async (_req, res) => {
  try {
    const r = await fetch(`${config.dlhdUrl}/api/channels`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/proxy") || req.path.startsWith("/live") || req.path.startsWith("/stremio") || req.path.startsWith("/library") || req.path.startsWith("/resolve") || req.path.startsWith("/health")) {
    return next();
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`JustOne platform on :${config.port}`);
  console.log(`  public: ${config.publicUrl}`);
  console.log(`  cinepro public: ${config.cineproPublicUrl}`);
  console.log(`  cinepro internal: ${config.cineproUrl}`);
  console.log(`  dlhd: ${config.dlhdUrl}`);
});
