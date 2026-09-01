import crypto from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { config, withKey } from "./config.js";
import { liveBufferSettings, RollingTsMediaBuffer } from "./liveBuffer.js";

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

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
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
 * When LIVE_BUFFER_SECONDS is non-zero, ffmpeg output is kept continuously
 * behind the upstream in a bounded RAM-only delay line. MPEG-TS PCR timestamps
 * pace the delayed output, so brief HLS/CDN fetch stalls can consume the queued
 * media while late packets catch up. Streams without usable PCR timestamps
 * safely fall back to a wall-clock delay. Set LIVE_BUFFER_SECONDS=0 to restore
 * the previous immediate-delivery path.
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
    const bufferSettings = liveBufferSettings();
    const buffering = bufferSettings.delayMs > 0;
    let rollingBuffer = null;
    let started = false;
    let settled = false;
    let stderr = "";

    const setLiveHeaders = () => {
      const mode = buffering ? `rolling-${rollingBuffer?.mode || "pcr"}-ram` : "off";
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-JustOne-Live-Transport", "ffmpeg-hls-remux");
      res.setHeader("X-JustOne-Live-Buffer-Seconds", String(bufferSettings.seconds));
      res.setHeader("X-JustOne-Live-Buffer-Mode", mode);
      res.setHeader("X-JustOne-Live-Buffer-Max-Bytes", String(bufferSettings.maxBytes));
    };

    const ensureStarted = () => {
      if (started || res.destroyed || res.writableEnded) return false;
      started = true;
      setLiveHeaders();
      return true;
    };

    const onDrain = () => {
      rollingBuffer?.drain();
      if (!child.killed && !res.destroyed && !res.writableEnded) child.stdout.resume();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      rollingBuffer?.clear();
      req.off("aborted", stop);
      res.off("close", stop);
      res.off("drain", onDrain);
      resolve();
    };

    const stop = () => {
      rollingBuffer?.clear();
      if (!child.killed) child.kill("SIGKILL");
    };

    const connectDirectOutput = (initialChunk) => {
      if (started || res.destroyed || res.writableEnded) return;
      ensureStarted();

      const attach = () => {
        if (res.destroyed || res.writableEnded) {
          stop();
          return;
        }
        child.stdout.pipe(res, { end: false });
        child.stdout.resume();
      };

      if (initialChunk?.length) {
        const writable = res.write(initialChunk);
        if (!writable) {
          res.once("drain", attach);
          return;
        }
      }
      attach();
    };

    req.once("aborted", stop);
    res.once("close", stop);
    res.on("drain", onDrain);

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    if (buffering) {
      rollingBuffer = new RollingTsMediaBuffer({
        delayMs: bufferSettings.delayMs,
        maxBytes: bufferSettings.maxBytes,
        write(data) {
          if (res.destroyed || res.writableEnded) return false;
          ensureStarted();
          const writable = res.write(data);
          if (!writable) child.stdout.pause();
          return writable;
        },
        onModeChange(mode) {
          if (mode === "wall") log("live buffer", "PCR unavailable; using wall-clock rolling delay");
        },
        onOverflow(bytes) {
          log(
            "live buffer",
            `released-early bytes=${bytes}`,
            `limit=${bufferSettings.maxBytes}`,
          );
        },
      });

      child.stdout.on("data", (chunk) => {
        if (res.destroyed || res.writableEnded) return;
        rollingBuffer.push(chunk);
      });
    } else {
      child.stdout.once("data", (chunk) => {
        if (res.destroyed || res.writableEnded) return;
        connectDirectOutput(chunk);
      });
    }

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
  const value = String(url || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("m3u8") || value.includes(".m3u8")) {
    out["content-type"] = "application/vnd.apple.mpegurl";
    return out;
  }
  if (ct.includes("zstd") || value.includes(".zst") || value.includes("zstd")) {
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

/** Stable identity for the same upstream HLS resource across manifest refreshes. */
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
  hlsTargets.delete(token);
  hlsTargets.set(token, {
    url,
    headers: { ...(headers || {}) },
    hls: Boolean(hls),
    exp: Date.now() + HLS_TOKEN_TTL_MS,
  });
  return token;
}

const HLS_PROXY_SUFFIXES = new Set([
  "m3u8",
  "ts",
  "m4s",
  "m4a",
  "mp4",
  "aac",
  "mp3",
  "vtt",
  "webvtt",
  "mpegts",
  "mpg",
  "mpeg",
  "m2ts",
  "mts",
  "cmfv",
  "cmfa",
  "fmp4",
  "bin",
  "key",
]);

export function hlsProxySuffixForTarget(url, hls = false) {
  if (hls) return ".m3u8";
  try {
    const pathname = new URL(String(url)).pathname;
    const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
    const ext = String(match?.[1] || "").toLowerCase();
    if (HLS_PROXY_SUFFIXES.has(ext)) return `.${ext}`;
  } catch {
    /* extensionless/invalid target falls through to MPEG-TS */
  }
  return ".ts";
}

export function hlsTokenFromProxyPath(value) {
  return String(value || "").replace(/\.[a-z0-9]{1,8}$/i, "");
}

export function hlsTargetFor(token) {
  const key = hlsTokenFromProxyPath(token);
  const target = hlsTargets.get(key);
  if (!target) return null;
  if (target.exp <= Date.now()) {
    hlsTargets.delete(key);
    return null;
  }
  return target;
}

function hlsProxyUrl(url, headers, hls = false) {
  const token = registerHlsTarget(url, headers, hls);
  const suffix = hlsProxySuffixForTarget(url, hls);
  return withKey(`${config.publicUrl}/play/hls/${encodeURIComponent(token)}${suffix}`);
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

export function proxyStream(
  req,
  res,
  targetUrl,
  { filename = null, download = false, hops = 0, upstreamHeaders = {}, hls = false } = {},
) {
  let dest;
  try {
    dest = new URL(String(targetUrl));
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "bad upstream" });
    return;
  }

  const effectiveHeaders = { ...(upstreamHeaders || {}) };
  if (hops === 0 && !res.headersSent) res.setHeader("X-JustOne-Delivery", "proxy");

  const lib = dest.protocol === "https:" ? https : http;
  const likelyHls = hls || /\.m3u8(?:$|[?#])/i.test(String(targetUrl));
  const request = lib.request(
    dest,
    {
      method: "GET",
      headers: hopHeaders(req, dest.host, effectiveHeaders, { stripRange: likelyHls }),
      timeout: 120000,
    },
    (up) => {
      const location = up.headers.location;
      if (location && up.statusCode >= 300 && up.statusCode < 400 && hops < 5) {
        const next = new URL(location, dest).href;
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
  request.on("error", (error) => {
    log("play proxy", String(error.message || error));
    if (!res.headersSent) res.status(502).json({ error: "stream failed" });
    else res.destroy();
  });
  request.end();
}
