import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { movieFolder, episodeFile, downloadName, cleanTitle } from "./naming.js";

const TMDB = "https://api.themoviedb.org/3";
const titleCache = new Map();

function log(...a) {
  process.stdout.write(a.map(String).join(" ") + "\n");
}

export function internalize(url) {
  if (!url) return url;
  let out = String(url);
  const pairs = [
    [config.publicUrl + "/cinepro", config.cineproUrl],
    ["https://resolver.vpn4u.cc/cinepro", config.cineproUrl],
    [config.publicUrl.replace(/\/$/, "") + "/cinepro", config.cineproUrl],
    ["http://localhost:3000", config.cineproUrl],
    ["http://127.0.0.1:3000", config.cineproUrl],
  ];
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

export function playMoviePath(tmdbId, quality) {
  return `/play/movie/${tmdbId}?quality=${quality}`;
}

export function playEpisodePath(tmdbId, season, episode, quality) {
  return `/play/episode/${tmdbId}/${season}/${episode}?quality=${quality}`;
}

export function playLivePath(channelId) {
  const id = String(channelId).replace(/\.m3u8$/i, "");
  return `/play/live/${encodeURIComponent(id)}.m3u8`;
}

export function publicPlayUrl(pathAndQuery) {
  return `${config.publicUrl}${pathAndQuery}`;
}

async function tmdbGet(pathname) {
  if (!config.tmdbKey) return null;
  const hit = titleCache.get(pathname);
  if (hit && Date.now() < hit.exp) return hit.data;
  try {
    const url = new URL(TMDB + pathname);
    url.searchParams.set("api_key", config.tmdbKey);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    titleCache.set(pathname, { data, exp: Date.now() + 6 * 3600 * 1000 });
    return data;
  } catch {
    return null;
  }
}

export async function movieDownloadFilename(tmdbId, ext = "mp4") {
  const m = await tmdbGet(`/movie/${tmdbId}`);
  const title = m?.title || `tmdbid-${tmdbId}`;
  const year = String(m?.release_date || "").slice(0, 4) || "0000";
  const { file } = movieFolder(title, year, tmdbId);
  return downloadName(file, ext);
}

export async function episodeDownloadFilename(tmdbId, season, episode, ext = "mp4") {
  const s = await tmdbGet(`/tv/${tmdbId}`);
  const title = s?.name || `tmdbid-${tmdbId}`;
  const year = String(s?.first_air_date || "").slice(0, 4) || "0000";
  const epMeta = await tmdbGet(`/tv/${tmdbId}/season/${season}/episode/${episode}`);
  const file = episodeFile(title, year, season, episode, epMeta?.name);
  return downloadName(file, ext);
}

function hopHeaders(req, host) {
  const headers = { ...req.headers, host };
  delete headers.connection;
  delete headers["content-length"];
  delete headers["accept-encoding"];
  return headers;
}

function sanitizeOut(headers, filename, download) {
  const out = { ...headers };
  delete out.location;
  delete out.Location;
  delete out["set-cookie"];
  delete out["set-cookie2"];
  delete out.server;
  delete out["x-powered-by"];
  if (filename) {
    const safe = filename.replace(/["\r\n]/g, "");
    const kind = download ? "attachment" : "inline";
    out["content-disposition"] = `${kind}; filename="${safe}"`;
  }
  return out;
}

export function proxyStream(req, res, targetUrl, { filename, download = false, hops = 0 } = {}) {
  let dest;
  try {
    dest = new URL(internalize(targetUrl));
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "bad upstream" });
    return;
  }
  const lib = dest.protocol === "https:" ? https : http;
  const p = lib.request(
    dest,
    { method: req.method === "HEAD" ? "HEAD" : "GET", headers: hopHeaders(req, dest.host), timeout: 120000 },
    (up) => {
      const loc = up.headers.location;
      if (loc && up.statusCode >= 300 && up.statusCode < 400 && hops < 5) {
        const next = new URL(loc, dest).href;
        up.resume();
        return proxyStream(req, res, next, { filename, download, hops: hops + 1 });
      }
      const out = sanitizeOut(up.headers, filename, download);
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    },
  );
  p.on("error", (e) => {
    log("play proxy", String(e.message || e));
    if (!res.headersSent) res.status(502).json({ error: "stream failed" });
    else res.destroy();
  });
  if (req.method !== "HEAD") req.pipe(p);
  else p.end();
}

export { cleanTitle };
