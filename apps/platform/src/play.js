import crypto from "node:crypto";
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

export function parseLiveHlsPlaylist(text, base) {
  const body = String(text || "");
  const lines = body.split(/\r?\n/);
  const mediaSequenceMatch = /^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/im.exec(body);
  const mediaSequence = mediaSequenceMatch ? Number(mediaSequenceMatch[1]) : null;
  const targetDuration = Number(/^#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/im.exec(body)?.[1] || 2);
  const isMaster = /#EXT-X-STREAM-INF/i.test(body);
  const refs = [];
  const segments = [];
  let segmentIndex = 0;
  let programDateTime = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pdt = /^#EXT-X-PROGRAM-DATE-TIME:\s*(.+)$/i.exec(trimmed);
    if (pdt) {
      programDateTime = pdt[1].trim();
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    let url;
    try {
      url = new URL(trimmed, base).href;
    } catch {
      continue;
    }

    refs.push(url);
    if (!isMaster) {
      const sequence = mediaSequence == null ? null : mediaSequence + segmentIndex;
      const key =
        sequence != null
          ? `seq:${sequence}`
          : programDateTime
            ? `pdt:${programDateTime}`
            : null;
      segments.push({ url, sequence, key, index: segmentIndex });
      segmentIndex += 1;
      programDateTime = null;
    }
  }

  return { isMaster, refs, segments, mediaSequence, targetDuration };
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

function rememberBounded(queue, set, value, max = 240) {
  if (set.has(value)) return false;
  set.add(value);
  queue.push(value);
  while (queue.length > max) set.delete(queue.shift());
  return true;
}

export async function restreamMpegTs(req, res, inputUrl) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  req.on("close", stop);
  res.on("close", stop);
  let listUrl = localUrl(inputUrl);
  const seenKeys = [];
  const knownKeys = new Set();
  const seenHashes = [];
  const knownHashes = new Set();
  let lastMediaSequence = null;
  let started = false;

  try {
    for (let n = 0; n < 3600 && !ac.signal.aborted; n++) {
      const pl = await fetchRes(listUrl, ac.signal);
      if (pl.status < 200 || pl.status >= 400) throw new Error(`hls playlist returned ${pl.status}`);
      const text = pl.buf.toString("utf8");
      const parsed = parseLiveHlsPlaylist(text, pl.href);

      if (parsed.isMaster && parsed.refs[0]) {
        listUrl = parsed.refs[0];
        knownKeys.clear();
        seenKeys.length = 0;
        knownHashes.clear();
        seenHashes.length = 0;
        lastMediaSequence = null;
        continue;
      }
      if (!parsed.segments.length) throw new Error("empty hls");

      if (
        parsed.mediaSequence != null &&
        lastMediaSequence != null &&
        parsed.mediaSequence < lastMediaSequence
      ) {
        // Some live origins reset/restart their sequence counters. Sequence keys
        // from the previous epoch must not block the new live window.
        knownKeys.clear();
        seenKeys.length = 0;
      }
      if (parsed.mediaSequence != null) lastMediaSequence = parsed.mediaSequence;

      for (const segment of parsed.segments) {
        if (segment.key && knownKeys.has(segment.key)) continue;

        const seg = await fetchRes(segment.url, ac.signal);
        if (seg.status < 200 || seg.status >= 400 || !seg.buf?.length) continue;

        if (segment.key) {
          rememberBounded(seenKeys, knownKeys, segment.key);
        } else {
          // A few origins omit MEDIA-SEQUENCE and reuse a small set of segment
          // filenames. URL-based dedupe freezes those streams after one window.
          // Fingerprinting lets a reused filename carry fresh video while still
          // suppressing an unchanged playlist snapshot.
          const hash = crypto.createHash("sha1").update(seg.buf).digest("hex");
          if (!rememberBounded(seenHashes, knownHashes, hash)) continue;
        }

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

      const td = Number.isFinite(parsed.targetDuration) ? parsed.targetDuration : 2;
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

function registerHlsTarget(url, headers = {}, hls = false) {
  pruneHlsTargets();
  const token = crypto.randomBytes(18).toString("base64url");
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