import crypto from "node:crypto";
import { Readable } from "node:stream";
import { config, withKey } from "./config.js";

const TARGET_TTL_MS = Math.max(
  60_000,
  Number(process.env.LIVE_HLS_TARGET_TTL_MS || 30 * 60_000),
);
const TARGET_MAX = Math.max(1000, Number(process.env.LIVE_HLS_TARGET_MAX || 50_000));
const RENEW_INTERVAL_MS = Math.max(
  1000,
  Math.min(30_000, Number(process.env.LIVE_HLS_RENEW_INTERVAL_MS || 30_000)),
);
const RENEW_RETRY_DELAY_MS = Math.max(
  100,
  Math.min(2000, Number(process.env.LIVE_HLS_RENEW_RETRY_DELAY_MS || 350)),
);
const RENEW_BUDGET_MS = Math.max(
  2000,
  Math.min(15_000, Number(process.env.LIVE_HLS_RENEW_BUDGET_MS || 3000)),
);
const staleGraceRaw = Number(process.env.LIVE_HLS_STALE_GRACE_MS || 0);
const STALE_GRACE_MS =
  Number.isFinite(staleGraceRaw) && staleGraceRaw > 0
    ? Math.min(3_600_000, Math.max(1000, staleGraceRaw))
    : 0;
const MANIFEST_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.LIVE_HLS_MANIFEST_MAX_BYTES || 4 * 1024 * 1024),
);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const targets = new Map();
const renewalPromises = new Map();

const ASSET_SUFFIXES = new Set([
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
  "zst",
  "pdf",
]);

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url").slice(0, 24);
}

function cleanTargets(now = Date.now()) {
  for (const [token, target] of targets) {
    if (target.exp <= now) targets.delete(token);
  }
  while (targets.size > TARGET_MAX) {
    const oldest = targets.keys().next().value;
    if (!oldest) break;
    targets.delete(oldest);
  }
}

function normalizedUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:data|skd|urn):/i.test(raw)) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function suffixFor(url, playlist = false) {
  if (playlist) return ".m3u8";
  try {
    const match = /\.([a-z0-9]{1,8})$/i.exec(new URL(String(url)).pathname);
    const ext = String(match?.[1] || "").toLowerCase();
    if (ASSET_SUFFIXES.has(ext)) return `.${ext}`;
  } catch {
    /* opaque target falls through */
  }
  return ".ts";
}

function tokenFromPath(value) {
  return String(value || "").replace(/\.[a-z0-9]{1,8}$/i, "");
}

export function renewablePlaylistToken(channelId, rootUrl, selectorPath) {
  return digest(
    JSON.stringify([
      "live-playlist-v1",
      String(channelId || ""),
      String(rootUrl || ""),
      (selectorPath || []).map((value) => Number(value)),
    ]),
  );
}

function assetToken(url) {
  return digest(JSON.stringify(["live-asset-v1", String(url || "")]));
}

function publicTargetUrl(token, suffix) {
  return withKey(`${config.publicUrl}/play/renew/${encodeURIComponent(token)}${suffix}`);
}

function registerAsset(url) {
  cleanTargets();
  const token = assetToken(url);
  targets.delete(token);
  targets.set(token, {
    token,
    kind: "asset",
    url: String(url),
    exp: Date.now() + TARGET_TTL_MS,
  });
  return publicTargetUrl(token, suffixFor(url, false));
}

function registerPlaylist({ channelId, rootUrl, selectorPath, url }) {
  cleanTargets();
  const token = renewablePlaylistToken(channelId, rootUrl, selectorPath);
  const previous = targets.get(token);
  const target = {
    token,
    kind: "playlist",
    channelId: String(channelId || ""),
    rootUrl: String(rootUrl || ""),
    selectorPath: [...selectorPath],
    url: String(url),
    exp: Date.now() + TARGET_TTL_MS,
    lastResolvedAt: Date.now(),
    lastGoodBody: previous?.lastGoodBody || null,
    lastGoodAt: previous?.lastGoodAt || 0,
  };
  targets.delete(token);
  targets.set(token, target);
  return publicTargetUrl(token, ".m3u8");
}

function playlistUriTag(line) {
  return /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)/i.test(String(line).trim());
}

/** Return playlist targets in the exact ordinal order used by the rewriter. */
export function listHlsPlaylistTargets(text, baseUrl) {
  const out = [];
  let nextLineIsPlaylist = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!line.startsWith("#")) {
      const resolved = normalizedUrl(line, baseUrl);
      if (resolved && (nextLineIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved))) out.push(resolved);
      nextLineIsPlaylist = false;
      continue;
    }

    const uriIsPlaylist = playlistUriTag(line);
    const uriMatches = [...rawLine.matchAll(/URI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gi)];
    for (const match of uriMatches) {
      const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
      const resolved = normalizedUrl(value, baseUrl);
      if (resolved && (uriIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved))) out.push(resolved);
    }
    nextLineIsPlaylist = /^#EXT-X-STREAM-INF/i.test(line);
  }
  return out;
}

/**
 * Rewrite a manifest while keeping every child playlist on a stable JustOne
 * identity. The signed upstream URL may change; the client-facing URL does not.
 */
export function rewriteRenewableManifest(
  text,
  baseUrl,
  { channelId, rootUrl, selectorPath = [] },
) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let nextLineIsPlaylist = false;
  let playlistOrdinal = 0;

  const localUrl = (resolved, playlist) => {
    if (!playlist) return registerAsset(resolved);
    const path = [...selectorPath, playlistOrdinal];
    playlistOrdinal += 1;
    return registerPlaylist({ channelId, rootUrl, selectorPath: path, url: resolved });
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push(rawLine);
      continue;
    }

    if (!trimmed.startsWith("#")) {
      const resolved = normalizedUrl(trimmed, baseUrl);
      if (!resolved) {
        out.push(rawLine);
      } else {
        const playlist = nextLineIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved);
        out.push(localUrl(resolved, playlist));
      }
      nextLineIsPlaylist = false;
      continue;
    }

    const uriIsPlaylist = playlistUriTag(trimmed);
    const rewritten = rawLine.replace(
      /URI=(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gi,
      (match, dq, sq, bare) => {
        const value = dq ?? sq ?? bare ?? "";
        const resolved = normalizedUrl(value, baseUrl);
        if (!resolved) return match;
        const playlist = uriIsPlaylist || /\.m3u8(?:$|[?#])/i.test(resolved);
        return `URI="${localUrl(resolved, playlist)}"`;
      },
    );
    out.push(rewritten);
    nextLineIsPlaylist = /^#EXT-X-STREAM-INF/i.test(trimmed);
  }

  return out.join("\n");
}

function requestHeaders(req, { manifest = false } = {}) {
  const headers = {
    "user-agent": UA,
    accept: "*/*",
  };
  if (!manifest && req?.headers?.range) headers.range = String(req.headers.range);
  return headers;
}

async function readLimited(response, maxBytes = MANIFEST_MAX_BYTES) {
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (length && length > maxBytes) throw new Error("live HLS manifest too large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) throw new Error("live HLS manifest too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best-effort cleanup */
    }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchManifest(url, deadline, req = null) {
  const remaining = Math.max(250, Number(deadline || 0) - Date.now());
  const response = await fetch(String(url), {
    method: "GET",
    headers: requestHeaders(req, { manifest: true }),
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(RENEW_BUDGET_MS, remaining)),
  });
  if (response.status < 200 || response.status >= 300) {
    try {
      await response.body?.cancel();
    } catch {
      /* best-effort cleanup */
    }
    const error = new Error(`live HLS upstream returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await readLimited(response);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("live HLS upstream returned no manifest");
  return { text, url: response.url || String(url) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveSelectorPath(target, deadline) {
  let currentUrl = target.rootUrl;
  for (let depth = 0; depth < target.selectorPath.length; depth += 1) {
    const manifest = await fetchManifest(currentUrl, deadline);
    const playlists = listHlsPlaylistTargets(manifest.text, manifest.url);
    const ordinal = target.selectorPath[depth];
    const selected = playlists[ordinal];
    if (!selected) {
      throw new Error(
        `live HLS playlist selector ${target.selectorPath.join(".")} missing at depth ${depth}`,
      );
    }
    currentUrl = selected;
  }
  return currentUrl;
}

async function renewPlaylistTarget(target, { force = false } = {}) {
  if (!target || target.kind !== "playlist") return target?.url || null;
  if (!force && Date.now() - target.lastResolvedAt < RENEW_INTERVAL_MS) return target.url;

  const existing = renewalPromises.get(target.token);
  if (existing) return existing;

  const promise = (async () => {
    const deadline = Date.now() + RENEW_BUDGET_MS;
    let lastError = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const freshUrl = await resolveSelectorPath(target, deadline);
        target.url = freshUrl;
        target.lastResolvedAt = Date.now();
        target.exp = Date.now() + TARGET_TTL_MS;
        log(
          "live hls renewable",
          `channel=${target.channelId}`,
          `path=${target.selectorPath.join(".")}`,
          `renewed attempt=${attempt}`,
        );
        return freshUrl;
      } catch (error) {
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining <= RENEW_RETRY_DELAY_MS) break;
        await sleep(Math.min(RENEW_RETRY_DELAY_MS * attempt, 1200, remaining));
      }
    }
    throw lastError || new Error("live HLS renewal timed out");
  })().finally(() => {
    renewalPromises.delete(target.token);
  });

  renewalPromises.set(target.token, promise);
  return promise;
}

function canServeLastGood(target) {
  if (!target?.lastGoodBody) return false;
  if (STALE_GRACE_MS === 0) return true;
  return Date.now() - target.lastGoodAt <= STALE_GRACE_MS;
}

function sendManifest(res, body, mode = "current") {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-JustOne-HLS-Renewal", mode);
  res.end(body);
}

async function servePlaylistTarget(req, res, target) {
  const deadline = Date.now() + RENEW_BUDGET_MS;
  let manifest;
  try {
    manifest = await fetchManifest(target.url, deadline, req);
  } catch (error) {
    log(
      "live hls renewable",
      `channel=${target.channelId}`,
      `path=${target.selectorPath.join(".")}`,
      `upstream-failed=${error?.status || error?.message || error}`,
    );

    if (canServeLastGood(target)) {
      void renewPlaylistTarget(target, { force: true }).catch((renewError) => {
        log(
          "live hls renewable",
          `channel=${target.channelId}`,
          `path=${target.selectorPath.join(".")}`,
          `renew-background-failed=${renewError?.message || renewError}`,
        );
      });
      sendManifest(res, target.lastGoodBody, "stale-hold");
      return;
    }

    try {
      await renewPlaylistTarget(target, { force: true });
      manifest = await fetchManifest(target.url, deadline, req);
    } catch (renewError) {
      if (!res.headersSent) {
        res.status(502).json?.({ error: "live HLS renewal failed" });
        if (!res.writableEnded && !res.headersSent) res.end("live HLS renewal failed");
      }
      return;
    }
  }

  const rewritten = rewriteRenewableManifest(manifest.text, manifest.url, {
    channelId: target.channelId,
    rootUrl: target.rootUrl,
    selectorPath: target.selectorPath,
  });
  target.lastGoodBody = rewritten;
  target.lastGoodAt = Date.now();
  target.exp = Date.now() + TARGET_TTL_MS;
  sendManifest(res, rewritten, "current");

  if (Date.now() - target.lastResolvedAt >= RENEW_INTERVAL_MS) {
    void renewPlaylistTarget(target).catch((error) => {
      log(
        "live hls renewable",
        `channel=${target.channelId}`,
        `path=${target.selectorPath.join(".")}`,
        `renew-proactive-failed=${error?.message || error}`,
      );
    });
  }
}

function sanitizedResponseHeaders(response, url) {
  const out = {};
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = response.headers?.get?.(name);
    if (value != null) out[name] = value;
  }
  const ct = String(out["content-type"] || "").toLowerCase();
  if (ct.includes("zstd") || /\.(?:zst|pdf)(?:$|[?#])/i.test(String(url))) {
    out["content-type"] = "video/mp2t";
  }
  out["cache-control"] = "no-store";
  return out;
}

async function serveAsset(req, res, target) {
  try {
    const response = await fetch(target.url, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: requestHeaders(req),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    res.writeHead(response.status, sanitizedResponseHeaders(response, response.url || target.url));
    if (req.method === "HEAD" || !response.body) {
      try {
        await response.body?.cancel();
      } catch {
        /* best-effort cleanup */
      }
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    log("live hls asset", String(error?.message || error));
    if (!res.headersSent) res.status(502).end("live HLS asset failed");
    else res.destroy();
  }
}

/** Serve the stable root manifest used by FFmpeg/Jellyfin. */
export async function proxyRenewableLiveManifest(req, res, { channelId, rootUrl }) {
  const rootToken = renewablePlaylistToken(channelId, rootUrl, []);
  let root = targets.get(rootToken);
  if (!root) {
    root = {
      token: rootToken,
      kind: "playlist",
      channelId: String(channelId || ""),
      rootUrl: String(rootUrl || ""),
      selectorPath: [],
      url: String(rootUrl || ""),
      exp: Date.now() + TARGET_TTL_MS,
      lastResolvedAt: Date.now(),
      lastGoodBody: null,
      lastGoodAt: 0,
    };
    targets.set(rootToken, root);
  } else {
    root.rootUrl = String(rootUrl || root.rootUrl);
    root.url = root.rootUrl;
    root.exp = Date.now() + TARGET_TTL_MS;
  }

  const deadline = Date.now() + RENEW_BUDGET_MS;
  try {
    const manifest = await fetchManifest(root.rootUrl, deadline, req);
    const rewritten = rewriteRenewableManifest(manifest.text, manifest.url, {
      channelId: root.channelId,
      rootUrl: root.rootUrl,
      selectorPath: [],
    });
    root.lastGoodBody = rewritten;
    root.lastGoodAt = Date.now();
    sendManifest(res, rewritten, "root");
  } catch (error) {
    if (canServeLastGood(root)) {
      sendManifest(res, root.lastGoodBody, "root-stale-hold");
      return;
    }
    if (!res.headersSent) res.status(502).end("live HLS root unavailable");
  }
}

/** Serve renewable nested playlists and ordinary segment/key assets. */
export async function proxyRenewableLiveAsset(req, res, tokenPath) {
  cleanTargets();
  const token = tokenFromPath(tokenPath);
  const target = targets.get(token);
  if (!target || target.exp <= Date.now()) {
    res.status(410).end("live HLS target expired");
    return;
  }
  target.exp = Date.now() + TARGET_TTL_MS;
  if (target.kind === "playlist") {
    await servePlaylistTarget(req, res, target);
    return;
  }
  await serveAsset(req, res, target);
}

export function renewableLiveStats() {
  let playlists = 0;
  let assets = 0;
  for (const target of targets.values()) {
    if (target.kind === "playlist") playlists += 1;
    else assets += 1;
  }
  return {
    targets: targets.size,
    playlists,
    assets,
    renewIntervalMs: RENEW_INTERVAL_MS,
    renewBudgetMs: RENEW_BUDGET_MS,
    staleGraceMs: STALE_GRACE_MS,
  };
}

export function resetRenewableLiveForTests() {
  targets.clear();
  renewalPromises.clear();
}
