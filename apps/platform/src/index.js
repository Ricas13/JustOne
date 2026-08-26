import express from "express";
import { config } from "./config.js";
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
  res.json({ service: "justone-platform", publicUrl: config.publicUrl, checks });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>JustOne</title>
<style>body{font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style></head>
<body>
<h1>JustOne</h1>
<p>Personal media hub — VOD (CinePro) + Live TV (dlhd-web) + STRM for Jellyfin + Stremio.</p>
<ul>
<li><a href="/health">/health</a></li>
<li><a href="/live/playlist.m3u8">/live/playlist.m3u8</a></li>
<li>Stremio addon (compose): <code>:7000/manifest.json</code></li>
</ul>
<p><strong>Personal use only.</strong> Streams are resolved from third parties; nothing is hosted here.</p>
</body></html>`);
});

/** Proxy helper — redirects or streams; v1 uses redirect for simplicity */
app.get("/proxy/vod", async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).send("url query required");
  }
  // v1: redirect. Later: pipe with headers / token refresh.
  res.redirect(302, target);
});

app.get("/proxy/live/:channelId", async (req, res) => {
  const id = req.params.channelId;
  try {
    const upstream = `${config.dlhdUrl}/api/stream/${id}.m3u8`;
    res.redirect(302, upstream);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

/** Live M3U — rewrite channel streams through JustOne proxy */
app.get("/live/playlist.m3u8", async (_req, res) => {
  try {
    const r = await fetch(`${config.dlhdUrl}/playlist.m3u8`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      return res.status(502).send(`dlhd playlist error: ${r.status}`);
    }
    let text = await r.text();
    // Point stream lines at our proxy when they reference /api/stream/
    text = text.replace(
      /https?:\/\/[^\s]+\/api\/stream\/(\d+)\.m3u8/g,
      `${config.publicUrl}/proxy/live/$1`,
    );
    // Relative API paths
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

/** Create movie STRM from an already-known stream URL */
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

/** Create episode STRM */
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

/**
 * Resolve movie sources via CinePro then optionally write STRM.
 * CinePro/OMSS paths may vary by version — adjust to your Core API.
 */
app.post("/resolve/movie", async (req, res) => {
  try {
    const { tmdbId, title, year, writeStrm = false } = req.body || {};
    if (!tmdbId && !title) {
      return res.status(400).json({ error: "tmdbId or title required" });
    }
    // Common OMSS-style path; fallback tries are documented in README
    const path = tmdbId
      ? `${config.cineproUrl}/movie/${tmdbId}`
      : `${config.cineproUrl}/search?q=${encodeURIComponent(title)}`;
    const r = await fetch(path, { signal: AbortSignal.timeout(60000) });
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

    const sources = data.sources || data.streams || data.results || [];
    let strm = null;
    if (writeStrm && sources.length && title) {
      const first = sources[0];
      const streamUrl = first.url || first.src || first.stream || first;
      if (typeof streamUrl === "string") {
        strm = await writeMovieStrm({
          title,
          year,
          streamUrl,
          tmdbId,
        });
      }
    }
    res.json({ ok: true, sources, strm });
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
  console.log(`  cinepro: ${config.cineproUrl}`);
  console.log(`  dlhd: ${config.dlhdUrl}`);
});
