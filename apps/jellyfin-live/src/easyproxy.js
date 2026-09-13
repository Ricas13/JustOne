import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { config, withKey } from "./config.js";

const easyProxyBase = new URL(`${config.easyProxyUrl}/`);
const easyProxyOrigin = easyProxyBase.origin;
const ephemeralSecret = crypto.randomBytes(32).toString("hex");
const bridgeSecret = Buffer.from(
  config.easyProxyBridgeSecret || config.playlistKey || ephemeralSecret,
  "utf8",
);

export const bridgeSecretPersistent = Boolean(config.easyProxyBridgeSecret || config.playlistKey);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signature(payload) {
  return crypto.createHmac("sha256", bridgeSecret).update(payload).digest("base64url");
}

export function easyProxyManifestUrl(sourceUrl) {
  const source = new URL(String(sourceUrl));
  if (!/^https?:$/.test(source.protocol)) throw new Error("EasyProxy source must be HTTP(S)");
  const target = new URL("proxy/manifest.m3u8", easyProxyBase);
  target.searchParams.set("url", source.href);
  return target.href;
}

export function encodeBridgeTarget(value) {
  const target = new URL(String(value), easyProxyBase);
  if (target.origin !== easyProxyOrigin) throw new Error("bridge target must be EasyProxy");
  const path = `${target.pathname}${target.search}`;
  const payload = Buffer.from(path, "utf8").toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function decodeBridgeTarget(token) {
  const value = String(token || "");
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) throw new Error("invalid bridge token");
  const payload = value.slice(0, dot);
  const supplied = value.slice(dot + 1);
  const expected = signature(payload);
  if (!safeEqual(supplied, expected)) throw new Error("invalid bridge signature");

  let path;
  try {
    path = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid bridge payload");
  }
  if (!path.startsWith("/")) throw new Error("invalid bridge path");

  const target = new URL(path, easyProxyBase);
  if (target.origin !== easyProxyOrigin) throw new Error("invalid bridge origin");
  return target;
}

function publicBridgeUrl(rawUrl) {
  try {
    const target = new URL(String(rawUrl), easyProxyBase);
    if (target.origin !== easyProxyOrigin) return String(rawUrl);
    const token = encodeBridgeTarget(target.href);
    return withKey(`${config.publicUrl}/jellyfin/proxy/${encodeURIComponent(token)}`);
  } catch {
    return String(rawUrl);
  }
}

function rewriteTagUris(line) {
  return String(line).replace(/URI=(['"])(.*?)\1/gi, (_match, quote, value) => {
    return `URI=${quote}${publicBridgeUrl(value)}${quote}`;
  });
}

export function rewriteEasyProxyManifest(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("#")) return rewriteTagUris(line);
      return publicBridgeUrl(line.trim());
    })
    .join("\n");
}

export async function resolveEasyProxyManifest(candidates, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(3_000, Number(options.timeoutMs || config.easyProxyRequestTimeoutMs));
  const log = options.log || (() => {});
  const failures = [];

  for (const [index, candidate] of (candidates || []).entries()) {
    const sourceUrl = String(candidate?.url || "").trim();
    if (!/^https?:\/\//i.test(sourceUrl)) continue;

    try {
      const upstreamUrl = easyProxyManifestUrl(sourceUrl);
      log(`EasyProxy candidate ${index + 1}: ${candidate?.label || sourceUrl}`);
      const response = await fetchImpl(upstreamUrl, {
        headers: {
          accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
          "user-agent": "JustOne EasyProxy bridge",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      if (!body.trimStart().startsWith("#EXTM3U")) {
        throw new Error(`invalid HLS manifest: ${body.slice(0, 120)}`);
      }

      return {
        body: rewriteEasyProxyManifest(body),
        candidateIndex: index,
        sourceUrl,
        upstreamUrl,
      };
    } catch (error) {
      const detail = String(error?.message || error);
      failures.push(`candidate ${index + 1}: ${detail}`);
      log(`EasyProxy candidate ${index + 1} failed: ${detail}`);
    }
  }

  const detail = failures.slice(-4).join("; ") || "no HTTP candidates";
  throw new Error(`all EasyProxy candidates failed (${detail})`);
}

export async function easyProxyHealth(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 3_000));
  try {
    const url = new URL("api/info", easyProxyBase);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "JustOne health" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const info = await response.json();
    return {
      ok: true,
      status: response.status,
      version: info?.version || null,
      proxy: info?.proxy || "EasyProxy",
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function copyRequestHeaders(req) {
  const headers = {};
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = req.headers?.[name];
    if (value) headers[name] = value;
  }
  headers["user-agent"] = req.headers?.["user-agent"] || "JustOne EasyProxy bridge";
  return headers;
}

function copyResponseHeaders(upstream, res) {
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function isManifestResponse(target, response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("mpegurl")) return true;

  // EasyProxy intentionally uses /proxy/manifest.m3u8 for both manifests and
  // media segments, so the bridge must not infer type from that route path.
  // A text response whose proxied source itself ends in .m3u8 is the only
  // fallback classification we need for badly labelled upstream manifests.
  if (contentType.startsWith("text/")) {
    const raw = target.searchParams.get("url");
    if (raw) {
      try {
        return new URL(raw).pathname.toLowerCase().endsWith(".m3u8");
      } catch {
        return false;
      }
    }
  }
  return false;
}

export async function proxyEasyProxyRequest(req, res, token, options = {}) {
  let target;
  try {
    target = decodeBridgeTarget(token);
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
    return;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once("close", onClose);

  try {
    const upstream = await fetchImpl(target, {
      headers: copyRequestHeaders(req),
      signal: controller.signal,
      redirect: "follow",
    });

    if (isManifestResponse(target, upstream)) {
      const body = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      res.send(rewriteEasyProxyManifest(body));
      return;
    }

    res.status(upstream.status);
    copyResponseHeaders(upstream, res);
    if (!upstream.body) {
      res.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (!res.headersSent) {
      res.status(502).json({ error: `EasyProxy bridge failed: ${String(error?.message || error)}` });
    } else {
      res.end();
    }
  } finally {
    res.removeListener("close", onClose);
  }
}
