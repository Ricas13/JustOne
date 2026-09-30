import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cacheRoot() {
  return path.resolve(process.env.DATA_DIR || "./data", "upstream-xmltv-cache");
}

function cacheKey(url) {
  return crypto.createHash("sha256").update(String(url)).digest("hex");
}

function cachePaths(url) {
  const key = cacheKey(url);
  const root = cacheRoot();
  return {
    root,
    body: path.join(root, `${key}.xml`),
    meta: path.join(root, `${key}.json`),
  };
}

export function isXmltvUrl(value) {
  try {
    const url = new URL(String(value));
    const pathname = url.pathname.toLowerCase();
    return pathname.includes("xmltv")
      || pathname.includes("epg")
      || pathname.endsWith(".xml")
      || pathname.endsWith(".xml.gz")
      || /(?:^|[?&])(?:xmltv|epg)=/i.test(url.search)
      || /(?:^|[?&])type=(?:xmltv|epg)(?:&|$)/i.test(url.search);
  } catch {
    return false;
  }
}

function responseHeaders(original, bodyLength, extra = {}) {
  const headers = new Headers(original?.headers || {});
  headers.delete("content-encoding");
  headers.set("content-length", String(bodyLength));
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

function isGeneratedJustOneXmltv(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  const prefix = buffer.subarray(0, Math.min(buffer.length, 128 * 1024)).toString("utf8");
  const tvTag = /<tv\b[^>]*>/i.exec(prefix)?.[0] || "";
  const match = /\bgenerator-info-name\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tvTag);
  return String(match?.[1] ?? match?.[2] ?? "").trim().toLowerCase() === "justone catalog";
}

export function looksLikeUsefulXmltv(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  if (!buffer.length) return false;
  const prefix = buffer.subarray(0, Math.min(buffer.length, 128 * 1024)).toString("utf8");
  return /<tv[\s>]/i.test(prefix)
    && buffer.indexOf(Buffer.from("<channel")) >= 0
    && buffer.indexOf(Buffer.from("<programme")) >= 0;
}

async function loadCached(url, maxAgeMs, { allowStale = false } = {}) {
  const files = cachePaths(url);
  try {
    const [body, metaText] = await Promise.all([
      fs.readFile(files.body),
      fs.readFile(files.meta, "utf8"),
    ]);
    const meta = JSON.parse(metaText);
    const cachedAt = Date.parse(meta.cachedAt || "");
    if (!Number.isFinite(cachedAt)) return null;
    const ageMs = Math.max(0, Date.now() - cachedAt);
    const stale = ageMs > maxAgeMs;
    if (stale && !allowStale) return null;
    if (isGeneratedJustOneXmltv(body) || !looksLikeUsefulXmltv(body)) return null;
    return { body, meta, stale, ageMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

export async function loadCachedXmltv(url, {
  maxAgeMinutes = intEnv("UPSTREAM_XMLTV_CACHE_MAX_AGE_MINUTES", 72 * 60),
  allowStale = false,
} = {}) {
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes)) * 60 * 1000;
  return await loadCached(url, maxAgeMs, { allowStale });
}

export async function saveCachedXmltv(url, body, { contentType = "application/xml" } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""));
  if (isGeneratedJustOneXmltv(buffer) || !looksLikeUsefulXmltv(buffer)) return false;
  const files = cachePaths(url);
  await fs.mkdir(files.root, { recursive: true });
  const cachedAt = new Date().toISOString();
  const bodyTmp = `${files.body}.${process.pid}.${Date.now()}.tmp`;
  const metaTmp = `${files.meta}.${process.pid}.${Date.now()}.tmp`;
  const meta = {
    cachedAt,
    contentType: contentType || "application/xml",
    bytes: buffer.length,
  };
  await fs.writeFile(bodyTmp, buffer);
  await fs.writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`);
  await fs.rename(bodyTmp, files.body);
  await fs.rename(metaTmp, files.meta);
  return true;
}

function cachedResponse(url, cached, message, logger = console) {
  const host = (() => {
    try { return new URL(url).host; } catch { return "upstream"; }
  })();
  logger.warn?.(`${message}; using ${cached.stale ? "stale " : ""}cached real upstream XMLTV for ${host} from ${cached.meta.cachedAt}`);
  return new Response(cached.body, {
    status: 200,
    statusText: "OK (cached upstream XMLTV)",
    headers: {
      "content-type": cached.meta.contentType || "application/xml",
      "content-length": String(cached.body.length),
      "x-justone-upstream-cache": "1",
      ...(cached.stale ? { "x-justone-upstream-cache-stale": "1" } : {}),
    },
  });
}

export function createXmltvCachingFetch(fetchImpl, {
  maxAgeMinutes = intEnv("UPSTREAM_XMLTV_CACHE_MAX_AGE_MINUTES", 72 * 60),
  logger = console,
} = {}) {
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes)) * 60 * 1000;

  return async function xmltvCachingFetch(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
    if (!isXmltvUrl(url)) return fetchImpl(input, init);

    try {
      const response = await fetchImpl(input, init);
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer());

        // The cache wrapper is installed globally, so internal consumers may fetch
        // JustOne's own generated /epg/guide.xml. That is output, never upstream:
        // pass it through untouched and never persist it in the upstream cache.
        if (isGeneratedJustOneXmltv(body)) {
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response, body.length),
          });
        }

        if (looksLikeUsefulXmltv(body)) {
          try {
            await saveCachedXmltv(url, body, {
              contentType: response.headers.get("content-type") || "application/xml",
            });
          } catch (error) {
            logger.warn?.(`XMLTV cache write failed for ${new URL(url).host}: ${error.message}`);
          }
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response, body.length),
          });
        }

        const cached = await loadCached(url, maxAgeMs, { allowStale: true });
        if (cached) {
          return cachedResponse(url, cached, `XMLTV upstream returned HTTP ${response.status} with an unusable body`, logger);
        }
        throw new Error(`XMLTV upstream ${new URL(url).host} returned HTTP ${response.status} with an unusable body`);
      }

      const cached = await loadCached(url, maxAgeMs, { allowStale: true });
      if (!cached) return response;
      return cachedResponse(url, cached, `XMLTV upstream returned HTTP ${response.status}`, logger);
    } catch (error) {
      const cached = await loadCached(url, maxAgeMs, { allowStale: true });
      if (!cached) throw error;
      return cachedResponse(url, cached, `XMLTV upstream failed (${error.message})`, logger);
    }
  };
}

export function installUpstreamXmltvCache() {
  const flag = Symbol.for("justone.upstreamXmltvCacheInstalled");
  if (globalThis[flag] || typeof globalThis.fetch !== "function") return;
  globalThis.fetch = createXmltvCachingFetch(globalThis.fetch.bind(globalThis));
  globalThis[flag] = true;
}
