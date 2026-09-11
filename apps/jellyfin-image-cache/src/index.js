import crypto from "node:crypto";
import http from "node:http";
import { ImageCache } from "./cache.js";
import { config } from "./config.js";
import { rewriteM3uImages, rewriteXmlTvImages } from "./rewrite.js";

const imageCache = new ImageCache({
  cacheDir: config.cacheDir,
  ttlMs: config.ttlMs,
  negativeTtlMs: config.negativeTtlMs,
  fetchTimeoutMs: config.fetchTimeoutMs,
  fetchConcurrency: config.fetchConcurrency,
  maxBytes: config.maxBytes,
});

function log(...values) {
  process.stdout.write(values.map(String).join(" ") + "\n");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorised(url, req) {
  if (!config.playlistKey) return true;
  return safeEqual(url.searchParams.get("key") || req.headers["x-playlist-key"] || "", config.playlistKey);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

async function requestBody(req, maxBytes = 2 * 1024 * 1024) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, total) : undefined;
}

function upstreamHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(lower)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, String(value));
    }
  }
  headers.set("accept-encoding", "identity");
  headers.set("x-justone-image-gateway", "1");
  return headers;
}

function copyResponseHeaders(upstream, res) {
  const skip = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);
  for (const [key, value] of upstream.headers) {
    if (skip.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

function rewriteKind(pathname, contentType) {
  const type = String(contentType || "").toLowerCase();
  if (/\.m3u8$/i.test(pathname) || type.includes("mpegurl")) return "m3u";
  if (/\/guide\.xml$/i.test(pathname) || type.includes("xml")) return "xml";
  return "";
}

async function proxyMetadata(req, res, requestUrl) {
  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, config.upstreamUrl);
  const body = await requestBody(req);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders(req),
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  res.statusCode = upstream.status;
  copyResponseHeaders(upstream, res);
  res.setHeader("x-justone-image-gateway", "1");
  if (req.method === "HEAD") return res.end();

  const raw = Buffer.from(await upstream.arrayBuffer());
  const kind = rewriteKind(requestUrl.pathname, upstream.headers.get("content-type"));
  if (!kind || !upstream.ok) return res.end(raw);

  const text = raw.toString("utf8");
  const options = { publicUrl: config.publicUrl, playlistKey: config.playlistKey };
  const rewritten = kind === "m3u"
    ? rewriteM3uImages(text, imageCache, options)
    : rewriteXmlTvImages(text, imageCache, options);

  res.removeHeader("content-length");
  res.setHeader("x-justone-image-cache-rewrite", "1");
  return res.end(rewritten);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://gateway.local");
  try {
    if (requestUrl.pathname === "/jellyfin/image-cache/health") {
      return sendJson(res, 200, {
        service: "justone-jellyfin-image-cache",
        ok: true,
        upstream: config.upstreamUrl,
        cache: imageCache.snapshot(),
      });
    }

    const imageMatch = /^\/jellyfin\/image\/([a-f0-9]{64})$/i.exec(requestUrl.pathname);
    if (imageMatch) {
      if (!authorised(requestUrl, req)) return sendJson(res, 401, { error: "key required" });
      const result = await imageCache.get(imageMatch[1]);
      res.statusCode = 200;
      res.setHeader("Content-Type", result.contentType || "image/png");
      res.setHeader("Content-Length", result.body.length);
      res.setHeader("x-justone-image-cache", result.state);
      res.setHeader(
        "Cache-Control",
        result.state === "fallback"
          ? "public, max-age=300"
          : result.state === "stale"
            ? "public, max-age=3600"
            : "public, max-age=86400",
      );
      if (req.method === "HEAD") return res.end();
      return res.end(result.body);
    }

    if (!requestUrl.pathname.startsWith("/jellyfin/")) {
      return sendJson(res, 404, { error: "not found" });
    }

    return await proxyMetadata(req, res, requestUrl);
  } catch (error) {
    const message = String(error?.message || error);
    log("gateway error", req.method, requestUrl.pathname, message);
    if (!res.headersSent) return sendJson(res, 502, { error: "metadata proxy failed" });
    return res.end();
  }
});

server.listen(config.port, "0.0.0.0", () => {
  log(`JustOne Jellyfin image cache gateway on :${config.port}`);
});
