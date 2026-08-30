import http from "node:http";
import https from "node:https";
import { config, withKey } from "./config.js";
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
  const id = String(channelId).replace(/\.(m3u8|ts)$/i, "");
  return `/play/live/${encodeURIComponent(id)}.ts`;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function localUrl(url) {
  let u = internalize(String(url));
  u = u.replace(config.publicUrl, `http://127.0.0.1:${config.port}`);
  u = u.replace("https://resolver.vpn4u.cc", `http://127.0.0.1:${config.port}`);
  return u;
}

function hlsRefs(text, base) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      out.push(new URL(t, base).href);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function fetchRes(url, signal) {
  const dest = new URL(localUrl(url));
  const lib = dest.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      dest,
      {
        method: "GET",
        headers: { host: dest.host, "user-agent": UA, accept: "*/*" },
        timeout: 20000,
      },
      (up) => {
        const loc = up.headers.location;
        if (loc && up.statusCode >= 300 && up.statusCode < 400) {
          up.resume();
          return resolve(fetchRes(new URL(loc, dest).href, signal));
        }
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () =>
          resolve({ status: up.statusCode, buf: Buffer.concat(chunks), href: dest.href }),
        );
        up.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    signal?.addEventListener("abort", () => req.destroy());
    req.end();
  });
}

export async function restreamMpegTs(req, res, inputUrl) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  req.on("close", stop);
  res.on("close", stop);
  let listUrl = localUrl(inputUrl);
  const seen = [];
  const known = new Set();
  let started = false;
  try {
    for (let n = 0; n < 3600 && !ac.signal.aborted; n++) {
      const pl = await fetchRes(listUrl, ac.signal);
      const text = pl.buf.toString("utf8");
      const refs = hlsRefs(text, pl.href);
      if (/#EXT-X-STREAM-INF/i.test(text) && refs[0]) {
        listUrl = refs[0];
        continue;
      }
      if (!refs.length) throw new Error("empty hls");
      for (const u of refs) {
        if (known.has(u)) continue;
        known.add(u);
        seen.push(u);
        if (seen.length > 60) {
          known.delete(seen.shift());
        }
        const seg = await fetchRes(u, ac.signal);
        if (!seg.buf?.length) continue;
        if (!started) {
          res.setHeader("Content-Type", "video/mp2t");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          started = true;
        }
        if (!res.write(seg.buf)) {
          await new Promise((r) => res.once("drain", r));
        }
      }
      const td = Number(/#EXT-X-TARGETDURATION:(\d+)/i.exec(text)?.[1] || 2);
      await new Promise((r) => setTimeout(r, Math.min(Math.max(td, 1), 4) * 400));
    }
  } catch (e) {
    log("ts pump", String(e.message || e));
    if (!started && !res.headersSent) res.status(502).end("live pump failed");
  } finally {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

export function publicPlayUrl(pathAndQuery) {
  return withKey(`${config.publicUrl}${pathAndQuery}`);
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

function hopHeaders(req, host, upstreamHeaders = {}) {
  const headers = { ...req.headers, host };
  for (const [key, value] of Object.entries(upstreamHeaders || {})) {
    if (!key || value == null) continue;
    headers[String(key).toLowerCase()] = String(value);
  }
  delete headers.connection;
  delete headers["content-length"];
  delete headers["accept-encoding"];
  if (!headers["user-agent"]) headers["user-agent"] = UA;
  if (!headers.accept) headers.accept = "*/*";
  return headers;
}

export function fixMediaType(out, url) {
  const ct = String(out["content-type"] || out["Content-Type"] || "").toLowerCase();
  const u = String(url || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("m3u8") || u.includes(".m3u8")) {
    out["content-type"] = "application/vnd.apple.mpegurl";
    return out;
  }
  if (ct.includes("zstd") || u.includes(".zst") || u.includes("zstd")) {
    out["content-type"] = "video/mp2t";
  }
  return out;
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

export function proxyStream(
  req,
  res,
  targetUrl,
  { filename, download = false, hops = 0, upstreamHeaders = {} } = {},
) {
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
    { method: "GET", headers: hopHeaders(req, dest.host, upstreamHeaders), timeout: 120000 },
    (up) => {
      const loc = up.headers.location;
      if (loc && up.statusCode >= 300 && up.statusCode < 400 && hops < 5) {
        const next = new URL(loc, dest).href;
        up.resume();
        return proxyStream(req, res, next, {
          filename,
          download,
          hops: hops + 1,
          upstreamHeaders,
        });
      }
      const out = fixMediaType(sanitizeOut(up.headers, filename, download), dest.href);
      if (String(dest.pathname).includes(".m3u8") && !out["content-type"]) {
        out["content-type"] = "application/vnd.apple.mpegurl";
      }
      if (req.method === "HEAD") {
        delete out["content-length"];
        res.writeHead(up.statusCode && up.statusCode < 400 ? up.statusCode : 200, out);
        up.resume();
        res.end();
        return;
      }
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    },
  );
  p.on("error", (e) => {
    log("play proxy", String(e.message || e));
    if (!res.headersSent) res.status(502).json({ error: "stream failed" });
    else res.destroy();
  });
  p.end();
}

export { cleanTitle };
