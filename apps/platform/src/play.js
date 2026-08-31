import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { config, withKey } from "./config.js";
import { movieFolder, episodeFile, downloadName, cleanTitle } from "./naming.js";
import { sourceHeadersFor } from "./services/sourceHeaders.js";

const TMDB = "https://api.themoviedb.org/3";
const titleCache = new Map();
const hlsTargets = new Map();
const HLS_TOKEN_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.HLS_PROXY_TOKEN_TTL_MS || 12 * 60 * 60 * 1000),
);
const HLS_TARGET_MAX = Math.max(1000, Number(process.env.HLS_PROXY_TARGET_MAX || 50000));
const HLS_MANIFEST_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.HLS_PROXY_MANIFEST_MAX_BYTES || 4 * 1024 * 1024),
);
const DIRECT_MEDIA_HANDOFF_ENABLED =
  String(process.env.DIRECT_MEDIA_HANDOFF || "true") !== "false";
const DIRECT_MEDIA_HANDOFF_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.DIRECT_MEDIA_HANDOFF_TIMEOUT_MS || 30000),
);

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

/**
 * Jellyfin is fed MPEG-TS for Live TV compatibility, but the upstream is HLS.
 * Let ffmpeg own HLS sequence tracking, encryption keys and discontinuities.
 *
 * The previous hand-written pump compared rewritten /play/hls/<random-token>
 * URLs. Every manifest refresh generated new random tokens for the same HLS
 * segment, so the pump replayed the whole 20-30 second live window repeatedly.
 * ffmpeg follows EXT-X-MEDIA-SEQUENCE instead and remuxes without transcoding.
 */
export function restreamMpegTs(req, res, inputUrl) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-fflags",
      "+genpts+discardcorrupt",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2",
      "-i",
      String(inputUrl),
      "-map",
      "0:v?",
      "-map",
      "0:a?",
      "-c",
      "copy",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
      "-f",
      "mpegts",
      "pipe:1",
    ];

    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let started = false;
    let settled = false;
    let stderr = "";

    const finish = () => {
      if (settled) return;
      settled = true;
      req.off("aborted", stop);
      res.off("close", stop);
      resolve();
    };

    const stop = () => {
      if (!child.killed) child.kill("SIGKILL");
    };

    req.once("aborted", stop);
    res.once("close", stop);

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    child.stdout.once("data", (chunk) => {
      if (res.destroyed || res.writableEnded) return;
      started = true;
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-JustOne-Live-Transport", "ffmpeg-hls-remux");
      res.write(chunk);
      child.stdout.pipe(res, { end: false });
    });

    child.on("error", (error) => {
      log("live ffmpeg", String(error?.message || error));
      if (!started && !res.headersSent && !res.destroyed) {
        res.status(502).end("live remux failed");
      }
      finish();
    });

    child.on("close", (code, signal) => {
      if (stderr.trim()) log("live ffmpeg", `exit=${code}`, `signal=${signal || ""}`, stderr.trim());
      if (!started && !res.headersSent && !res.destroyed) {
        res.status(502).end("live remux failed");
      } else if (started && !res.writableEnded && !res.destroyed) {
        res.end();
      }
      finish();
    });
  });
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
  const file = episodeFile(title, year, season, episode, epMeta?.name, tmdbId);
  return downloadName(file, ext);
}

function hopHeaders(req, host, upstreamHeaders = {}, { stripRange = false } = {}) {
  const headers = { ...req.headers, host };
  delete headers.connection;
  delete headers["content-length"];
  delete headers["accept-encoding"];
  if (stripRange) {
    delete headers.range;
    delete headers.Range;
  }
  headers["user-agent"] = UA;
  headers.accept = "*/*";
  for (const [key, value] of Object.entries(upstreamHeaders || {})) {
    if (!key || value == null) continue;
    headers[String(key).toLowerCase()] = String(value);
  }
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

function pruneHlsTargets(now = Date.now()) {
  for (const [token, target] of hlsTargets) {
    if (target.exp <= now) hlsTargets.delete(token);
  }
  while (hlsTargets.size > HLS_TARGET_MAX) {
    const oldest = hlsTargets.keys().next().value;
    if (!oldest) break;
    hlsTargets.delete(oldest);
  }
}

function normalizedHlsHeaders(headers = {}) {
  return Object.entries(headers || {})
    .filter(([key, value]) => key && value != null)
    .map(([key, value]) => [String(key).toLowerCase(), String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Stable identity for a specific upstream HLS resource. The same segment must
 * keep the same local URL across manifest refreshes; otherwise a restreamer or
 * player can mistake an old live-window segment for a new one.
 */
export function hlsTokenForTarget(url, headers = {}, hls = false) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([String(url), normalizedHlsHeaders(headers), Boolean(hls)]))
    .digest("base64url")
    .slice(0, 24);
}

function registerHlsTarget(url, headers = {}, hls = false) {
  pruneHlsTargets();
  const token = hlsTokenForTarget(url, headers, hls);
  // Refresh the TTL and insertion order for an actively referenced target.
  hlsTargets.delete(token);
  hlsTargets.set(token, {
    url,
    headers: { ...(headers || {}) },
    hls: Boolean(hls),
    exp: Date.now() + HLS_TOKEN_TTL_MS,
  });
  return token;
}

export function hlsTargetFor(token) {
  const target = hlsTargets.get(String(token || ""));
  if (!target) return null;
  if (target.exp <= Date.now()) {
    hlsTargets.delete(String(token));
    return null;
  }
  return target;
}

function hlsProxyUrl(url, headers, hls = false) {
  const token = registerHlsTarget(url, headers, hls);
  return withKey(`${config.publicUrl}/play/hls/${encodeURIComponent(token)}`);
}

function resolveHlsUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:data|skd|urn):/i.test(raw)) return null;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.href;
  } catch {
    return null;
  }
}

export function rewriteHlsManifest(text, baseUrl, makeProxyUrl) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let nextLineIsPlaylist = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (!trimmed.startsWith("#")) {
      const resolved = resolveHlsUrl(trimmed, baseUrl);
      if (!resolved) {
        out.push(line);
      } else {
        const hls = nextLineIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved);
        out.push(makeProxyUrl(resolved, hls));
      }
      nextLineIsPlaylist = false;
      continue;
    }

    const uriIsPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)/i.test(trimmed);
    const rewritten = line.replace(
      /URI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gi,
      (match, dq, sq, bare) => {
        const value = dq ?? sq ?? bare ?? "";
        const resolved = resolveHlsUrl(value, baseUrl);
        if (!resolved) return match;
        const hls = uriIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved);
        return `URI="${makeProxyUrl(resolved, hls)}"`;
      },
    );
    out.push(rewritten);
    nextLineIsPlaylist = /^#EXT-X-STREAM-INF/i.test(trimmed);
  }

  return out.join("\n");
}

function isHlsResponse(headers, dest, forceHls) {
  if (forceHls) return true;
  const ct = String(headers?.["content-type"] || headers?.["Content-Type"] || "").toLowerCase();
  return ct.includes("mpegurl") || ct.includes("m3u8") || /\.m3u8$/i.test(dest.pathname);
}

function proxyHlsManifest(req, res, up, dest, out, effectiveHeaders) {
  const chunks = [];
  let bytes = 0;
  let failed = false;

  up.on("data", (chunk) => {
    if (failed) return;
    bytes += chunk.length;
    if (bytes > HLS_MANIFEST_MAX_BYTES) {
      failed = true;
      up.destroy(new Error("hls manifest too large"));
      return;
    }
    chunks.push(chunk);
  });

  up.on("end", () => {
    if (failed || res.headersSent) return;
    const body = Buffer.concat(chunks).toString("utf8");
    const rewritten = rewriteHlsManifest(body, dest.href, (url, hls) =>
      hlsProxyUrl(url, effectiveHeaders, hls),
    );
    delete out["content-length"];
    delete out["content-range"];
    delete out["accept-ranges"];
    delete out["transfer-encoding"];
    out["content-type"] = "application/vnd.apple.mpegurl";
    out["cache-control"] = "no-store";
    res.writeHead(up.statusCode && up.statusCode < 400 ? 200 : up.statusCode || 502, out);
    res.end(rewritten);
  });

  up.on("error", (error) => {
    log("hls proxy", String(error?.message || error));
    if (!res.headersSent) res.status(502).json({ error: "hls stream failed" });
    else res.destroy();
  });
}

function privateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local")) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = /^172\.(\d+)\./.exec(host);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return false;
}

function externalHandoffUrl(value, providerUrl = config.streamProviderUrl) {
  try {
    const url = new URL(String(value));
    const provider = new URL(providerUrl);
    const publicOrigin = new URL(config.publicUrl).origin;
    const cineproOrigin = new URL(config.cineproUrl).origin;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.origin === provider.origin || url.origin === publicOrigin || url.origin === cineproOrigin) {
      return null;
    }
    if (privateHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function directHandoffEligible(
  targetUrl,
  {
    filename = null,
    download = false,
    upstreamHeaders = {},
    providerUrl = config.streamProviderUrl,
    enabled = DIRECT_MEDIA_HANDOFF_ENABLED,
  } = {},
) {
  if (!enabled || !filename || download) return false;
  if (Object.keys(upstreamHeaders || {}).length) return false;

  try {
    const target = new URL(String(targetUrl));
    const provider = new URL(providerUrl);
    if (target.origin === provider.origin) {
      return /\/extract\/?$/i.test(target.pathname);
    }
    return Boolean(externalHandoffUrl(target.href, providerUrl));
  } catch {
    return false;
  }
}

export async function resolveDirectHandoffTarget(
  targetUrl,
  {
    filename = null,
    download = false,
    upstreamHeaders = {},
    providerUrl = config.streamProviderUrl,
    enabled = DIRECT_MEDIA_HANDOFF_ENABLED,
    timeoutMs = DIRECT_MEDIA_HANDOFF_TIMEOUT_MS,
  } = {},
) {
  if (
    !directHandoffEligible(targetUrl, {
      filename,
      download,
      upstreamHeaders,
      providerUrl,
      enabled,
    })
  ) {
    return null;
  }

  const direct = externalHandoffUrl(targetUrl, providerUrl);
  if (direct) return direct;

  let dest;
  try {
    dest = new URL(String(targetUrl));
  } catch {
    return null;
  }
  const lib = dest.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = lib.request(
      dest,
      {
        method: "GET",
        headers: { host: dest.host, "user-agent": UA, accept: "*/*" },
        timeout: Math.max(1000, Number(timeoutMs || DIRECT_MEDIA_HANDOFF_TIMEOUT_MS)),
      },
      (up) => {
        const status = Number(up.statusCode || 0);
        const location = up.headers.location;
        up.resume();
        if (location && status >= 300 && status < 400) {
          try {
            const next = new URL(location, dest).href;
            finish(externalHandoffUrl(next, providerUrl));
          } catch {
            finish(null);
          }
          return;
        }
        finish(null);
      },
    );
    request.on("timeout", () => request.destroy(new Error("direct handoff timeout")));
    request.on("error", () => finish(null));
    request.end();
  });
}

export function proxyHlsToken(req, res, token) {
  const target = hlsTargetFor(token);
  if (!target) {
    res.status(410).json({ error: "hls token expired" });
    return;
  }
  proxyStream(req, res, target.url, {
    filename: null,
    download: false,
    upstreamHeaders: target.headers,
    hls: target.hls,
  });
}

export async function proxyStream(
  req,
  res,
  targetUrl,
  { filename, download = false, hops = 0, upstreamHeaders = {}, hls = false } = {},
) {
  let dest;
  try {
    dest = new URL(internalize(targetUrl));
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "bad upstream" });
    return;
  }
  const rememberedHeaders = sourceHeadersFor(targetUrl);
  const effectiveHeaders = { ...rememberedHeaders, ...upstreamHeaders };

  if (hops === 0) {
    const directUrl = await resolveDirectHandoffTarget(targetUrl, {
      filename,
      download,
      upstreamHeaders: effectiveHeaders,
    });
    if (directUrl && !res.headersSent) {
      res.setHeader("X-JustOne-Delivery", "direct");
      res.setHeader("Cache-Control", "no-store");
      res.redirect(302, directUrl);
      return;
    }
    if (!res.headersSent) res.setHeader("X-JustOne-Delivery", "proxy");
  }

  const lib = dest.protocol === "https:" ? https : http;
  const likelyHls = hls || /\.m3u8(?:$|[?#])/i.test(String(targetUrl));
  const p = lib.request(
    dest,
    {
      method: "GET",
      headers: hopHeaders(req, dest.host, effectiveHeaders, { stripRange: likelyHls }),
      timeout: 120000,
    },
    (up) => {
      const loc = up.headers.location;
      if (loc && up.statusCode >= 300 && up.statusCode < 400 && hops < 5) {
        const next = new URL(loc, dest).href;
        up.resume();
        return proxyStream(req, res, next, {
          filename,
          download,
          hops: hops + 1,
          upstreamHeaders: effectiveHeaders,
          hls,
        });
      }
      const out = fixMediaType(sanitizeOut(up.headers, filename, download), dest.href);
      if (req.method === "HEAD") {
        delete out["content-length"];
        res.writeHead(up.statusCode && up.statusCode < 400 ? up.statusCode : 200, out);
        up.resume();
        res.end();
        return;
      }
      if (isHlsResponse(up.headers, dest, hls)) {
        proxyHlsManifest(req, res, up, dest, out, effectiveHeaders);
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
