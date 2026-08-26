import express from "express";
import { config, publicizeStreamUrl } from "./config.js";
import { writeMovieStrm, writeEpisodeStrm } from "./strm.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>JustOne</title>
<style>body{font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style></head>
<body>
<h1>JustOne</h1>
<p>Public: <code>${config.publicUrl}</code></p>
<ul>
<li><a href="/health">/health</a></li>
<li><a href="/live/playlist.m3u8">/live/playlist.m3u8</a></li>
<li>Live Stremio: <code>${config.publicUrl}/stremio-live/manifest.json</code></li>
<li>VOD Stremio (CinePro): <code>${config.cineproPublicUrl}/stremio/manifest.json</code></li>
</ul>
<p><strong>Personal use only.</strong></p>
</body></html>`);
});

app.get("/proxy/vod", async (req, res) => {
  let target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).send("url query required");
  }
  target = publicizeStreamUrl(target);
  // If still an internal cinepro URL, force public
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
      return res.status(502).send(`dlhd playlist error: ${r.status}`);
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
      return res.status(400).json({ error: "tmdbId required (CinePro uses TMDB ids)" });
    }
    const path = `${config.cineproUrl}/v1/movies/${tmdbId}`;
    const r = await fetch(path, { signal: AbortSignal.timeout(90000) });
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
      const streamUrl = sourceUrl(sources[0]);
      if (streamUrl) {
        strm = await writeMovieStrm({ title, year, streamUrl, tmdbId });
      }
    }
    res.json({ ok: true, path, sources, strm });
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
    const path = `${config.cineproUrl}/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`;
    const r = await fetch(path, { signal: AbortSignal.timeout(90000) });
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
      const streamUrl = sourceUrl(sources[0]);
      if (streamUrl) {
        strm = await writeEpisodeStrm({
          showTitle,
          season,
          episode,
          episodeTitle,
          streamUrl,
          tmdbId,
        });
      }
    }
    res.json({ ok: true, path, sources, strm });
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

app.listen(config.port, "0.0.0.0", () => {
  console.log(`JustOne platform on :${config.port}`);
  console.log(`  public: ${config.publicUrl}`);
  console.log(`  cinepro public: ${config.cineproPublicUrl}`);
  console.log(`  cinepro internal: ${config.cineproUrl}`);
  console.log(`  dlhd: ${config.dlhdUrl}`);
});
