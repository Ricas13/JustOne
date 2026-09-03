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

const LIVE_FFMPEG_RESTART_DELAY_MS = Math.max(
  100,
  Math.min(10000, Number(process.env.LIVE_FFMPEG_RESTART_DELAY_MS || 500)),
);
const LIVE_FFMPEG_MAX_RESTARTS_PER_SOURCE = Math.max(
  0,
  Math.min(20, Number(process.env.LIVE_FFMPEG_MAX_RESTARTS_PER_SOURCE || 3)),
);
const LIVE_FFMPEG_STABLE_MS = Math.max(
  1000,
  Number(process.env.LIVE_FFMPEG_STABLE_MS || 15000),
);
const LIVE_FAILOVER_MAX_SWITCHES = Math.max(
  0,
  Math.min(100, Number(process.env.LIVE_FAILOVER_MAX_SWITCHES || 12)),
);
const LIVE_FFMPEG_RW_TIMEOUT_US = Math.max(
  5_000_000,
  Number(process.env.LIVE_FFMPEG_RW_TIMEOUT_US || 15_000_000),
);
const LIVE_FAILOVER_MAX_SOURCES = 8;

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

export function playLivePath(channelId) {
  const id = String(channelId).replace(/\.(m3u8|ts)$/i, "");
  return `/play/live/${encodeURIComponent(id)}.ts`;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Build the FFmpeg argv used for Jellyfin's MPEG-TS live transport. */
export function liveFfmpegArgs(inputUrl) {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-fflags",
    "+genpts+discardcorrupt",
    "-rw_timeout",
    String(LIVE_FFMPEG_RW_TIMEOUT_US),
    "-reconnect",
    "1",
    "-reconnect_at_eof",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_on_http_error",
    "4xx,5xx",
    "-reconnect_delay_max",
    "3",
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
    "-mpegts_flags",
    "+resend_headers+initial_discontinuity",
    "-f",
    "mpegts",
    "pipe:1",
  ];
}

function cleanFailoverId(value) {
  const id = String(value || "").trim().replace(/\.(?:ts|m3u8)$/i, "");
  if (!id || id.length > 160 || /[\r\n/\\]/.test(id)) return "";
  return id;
}

/**
 * Convert the event selector's bounded failover id list into loopback-only HLS
 * inputs. No user-supplied host is ever used, which keeps the feature outside
 * the SSRF boundary.
 */
export function liveFailoverInputUrls(req, initialInputUrl) {
  const raw = Array.isArray(req?.query?.failover)
    ? req.query.failover.join(",")
    : String(req?.query?.failover || "");
  const seen = new Set();
  const ids = [];
  for (const part of raw.split(",")) {
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      /* invalid percent-encoding is rejected by cleanFailoverId */
    }
    const id = cleanFailoverId(decoded);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= LIVE_FAILOVER_MAX_SOURCES - 1) break;
  }
  return [
    String(initialInputUrl),
    ...ids.map((id) => `http://127.0.0.1:${config.port}/play/live/${encodeURIComponent(id)}.m3u8`),
  ];
}

/**
 * Jellyfin is fed MPEG-TS while the upstream is HLS. One HTTP response remains
 * open for the whole viewing session. FFmpeg is supervised beneath it: short
 * failures restart the same source, and duplicate sports-event ids can switch
 * to the next source without sending Jellyfin EOF.
 */
export function restreamMpegTs(req, res, inputUrl, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const inputs = liveFailoverInputUrls(req, inputUrl);
    const bufferSettings = liveBufferSettings();
    const buffering = bufferSettings.delayMs > 0;
    let rollingBuffer = null;
    let currentChild = null;
    let currentInputIndex = 0;
    let sourceFailures = 0;
    let failoverSwitches = 0;
    let restartTimer = null;
    let spawnCount = 0;
    let started = false;
    let settled = false;
    let stopping = false;

    const currentInput = () => inputs[currentInputIndex];

    const setLiveHeaders = () => {
      const mode = buffering ? `rolling-${rollingBuffer?.mode || "pcr"}-ram` : "off";
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-JustOne-Live-Transport", "ffmpeg-hls-remux-supervised");
      res.setHeader("X-JustOne-Live-Buffer-Seconds", String(bufferSettings.seconds));
      res.setHeader("X-JustOne-Live-Buffer-Mode", mode);
      res.setHeader("X-JustOne-Live-Buffer-Max-Bytes", String(bufferSettings.maxBytes));
      res.setHeader("X-JustOne-Live-Failover-Sources", String(inputs.length));
    };

    const ensureStarted = () => {
      if (started || res.destroyed || res.writableEnded) return false;
      started = true;
      setLiveHeaders();
      return true;
    };

    const clearRestartTimer = () => {
      if (!restartTimer) return;
      clearTimeout(restartTimer);
      restartTimer = null;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearRestartTimer();
      rollingBuffer?.clear();
      req.off("aborted", stop);
      res.off("close", stop);
      res.off("drain", onDrain);
      resolve();
    };

    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearRestartTimer();
      rollingBuffer?.clear();
      if (currentChild && !currentChild.killed) currentChild.kill("SIGKILL");
      finish();
    };

    const onDrain = () => {
      rollingBuffer?.drain();
      const child = currentChild;
      if (child && !child.killed && !res.destroyed && !res.writableEnded) child.stdout.resume();
    };

    const finalFailure = () => {
      if (!started && !res.headersSent && !res.destroyed) {
        res.status(502).end("live remux failed");
      } else if (started && !res.writableEnded && !res.destroyed) {
        res.end();
      }
      finish();
    };

    const scheduleSpawn = (reason) => {
      if (stopping || settled || res.destroyed || res.writableEnded) return finish();
      clearRestartTimer();
      if (reason) {
        log(
          "live supervisor",
          reason,
          `source=${currentInputIndex + 1}/${inputs.length}`,
          `switches=${failoverSwitches}`,
        );
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        spawnCurrent();
      }, LIVE_FFMPEG_RESTART_DELAY_MS);
      restartTimer.unref?.();
    };

    const switchSource = () => {
      if (inputs.length <= 1 || failoverSwitches >= LIVE_FAILOVER_MAX_SWITCHES) return false;
      currentInputIndex = (currentInputIndex + 1) % inputs.length;
      failoverSwitches += 1;
      sourceFailures = 0;
      return true;
    };

    const writeChunk = (child, chunk) => {
      if (!chunk?.length || res.destroyed || res.writableEnded || stopping) return;
      if (buffering) {
        rollingBuffer.push(chunk);
        return;
      }
      ensureStarted();
      const writable = res.write(chunk);
      if (!writable) child.stdout.pause();
    };

    const spawnCurrent = () => {
      if (stopping || settled || res.destroyed || res.writableEnded) return finish();
      const sourceUrl = currentInput();
      if (spawnCount > 0) rollingBuffer?.beginSourceTransition();
      spawnCount += 1;
      const child = spawnImpl("ffmpeg", liveFfmpegArgs(sourceUrl), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      currentChild = child;
      const attemptStartedAt = Date.now();
      let attemptBytes = 0;
      let stderr = "";
      let closeHandled = false;

      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-8192);
      });

      child.stdout.on("data", (chunk) => {
        attemptBytes += chunk.length;
        writeChunk(child, chunk);
      });

      child.on("error", (error) => {
        log("live ffmpeg", String(error?.message || error));
      });

      child.on("close", (code, signal) => {
        if (closeHandled) return;
        closeHandled = true;
        if (currentChild === child) currentChild = null;
        if (stderr.trim()) {
          log(
            "live ffmpeg",
            `exit=${code}`,
            `signal=${signal || ""}`,
            `source=${currentInputIndex + 1}/${inputs.length}`,
            stderr.trim(),
          );
        }
        if (stopping || settled || res.destroyed || res.writableEnded) return finish();

        const stable = attemptBytes > 0 && Date.now() - attemptStartedAt >= LIVE_FFMPEG_STABLE_MS;
        sourceFailures = stable ? 0 : sourceFailures + 1;

        if (sourceFailures <= LIVE_FFMPEG_MAX_RESTARTS_PER_SOURCE) {
          scheduleSpawn(`restart=${sourceFailures}/${LIVE_FFMPEG_MAX_RESTARTS_PER_SOURCE}`);
          return;
        }

        if (switchSource()) {
          scheduleSpawn("mid-stream-source-failover");
          return;
        }

        log(
          "live supervisor",
          "exhausted",
          `source-failures=${sourceFailures}`,
          `switches=${failoverSwitches}`,
        );
        finalFailure();
      });
    };

    req.once("aborted", stop);
    res.once("close", stop);
    res.on("drain", onDrain);

    if (buffering) {
      rollingBuffer = new RollingTsMediaBuffer({
        delayMs: bufferSettings.delayMs,
        maxBytes: bufferSettings.maxBytes,
        write(data) {
          if (res.destroyed || res.writableEnded || stopping) return false;
          ensureStarted();
          const writable = res.write(data);
          if (!writable && currentChild && !currentChild.killed) currentChild.stdout.pause();
          return writable;
        },
        onModeChange(mode) {
          if (mode === "wall") log("live buffer", "PCR unavailable; using wall-clock rolling delay");
        },
        onOverflow(bytes) {
          log("live buffer", `released-early bytes=${bytes}`, `limit=${bufferSettings.maxBytes}`);
        },
      });
    }

    spawnCurrent();
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
  "m3u8", "ts", "m4s", "m4a", "mp4", "aac", "mp3", "vtt", "webvtt",
  "mpegts", "mpg", "mpeg", "m2ts", "mts", "cmfv", "cmfa", "fmp4", "bin", "key",
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
