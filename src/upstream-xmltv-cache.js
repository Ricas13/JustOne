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
      || pathname.endsWith(".xml")
      || pathname.endsWith(".xml.gz")
      || /(?:^|[?&])(?:xmltv|epg)=/i.test(url.search);
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

function looksLikeXmltv(body) {
  const prefix = body.subarray(0, Math.min(body.length, 128 * 1024)).toString("utf8");
  return /<tv[\s>]/i.test(prefix);
}

async function loadCached(url, maxAgeMs) {
  const files = cachePaths(url);
  try {
    const [body, metaText] = await Promise.all([
      fs.readFile(files.body),
      fs.readFile(files.meta, "utf8"),
    ]);
    const meta = JSON.parse(metaText);
    const cachedAt = Date.parse(meta.cachedAt || "");
    if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > maxAgeMs) return null;
    if (!looksLikeXmltv(body)) return null;
    return { body, meta };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function saveCached(url, body, response) {
  if (!looksLikeXmltv(body)) return;
  const files = cachePaths(url);
  await fs.mkdir(files.root, { recursive: true });
  const cachedAt = new Date().toISOString();
  const bodyTmp = `${files.body}.${process.pid}.${Date.now()}.tmp`;
  const metaTmp = `${files.meta}.${process.pid}.${Date.now()}.tmp`;
  const meta = {
    cachedAt,
    contentType: response.headers.get("content-type") || "application/xml",
    bytes: body.length,
  };
  await fs.writeFile(bodyTmp, body);
  await fs.writeFile(metaTmp, `${JSON.stringify(meta, null, 2)}\n`);
  await fs.rename(bodyTmp, files.body);
  await fs.rename(metaTmp, files.meta);
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
        if (looksLikeXmltv(body)) {
          try {
            await saveCached(url, body, response);
          } catch (error) {
            logger.warn?.(`XMLTV cache write failed for ${new URL(url).host}: ${error.message}`);
          }
        }
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders(response, body.length),
        });
      }

      const cached = await loadCached(url, maxAgeMs);
      if (!cached) return response;
      logger.warn?.(`XMLTV upstream ${new URL(url).host} returned HTTP ${response.status}; using cached real upstream XMLTV from ${cached.meta.cachedAt}`);
      return new Response(cached.body, {
        status: 200,
        statusText: "OK (cached upstream XMLTV)",
        headers: {
          "content-type": cached.meta.contentType || "application/xml",
          "content-length": String(cached.body.length),
          "x-justone-upstream-cache": "1",
        },
      });
    } catch (error) {
      const cached = await loadCached(url, maxAgeMs);
      if (!cached) throw error;
      logger.warn?.(`XMLTV upstream ${new URL(url).host} failed (${error.message}); using cached real upstream XMLTV from ${cached.meta.cachedAt}`);
      return new Response(cached.body, {
        status: 200,
        statusText: "OK (cached upstream XMLTV)",
        headers: {
          "content-type": cached.meta.contentType || "application/xml",
          "content-length": String(cached.body.length),
          "x-justone-upstream-cache": "1",
        },
      });
    }
  };
}

export function installUpstreamXmltvCache() {
  const flag = Symbol.for("justone.upstreamXmltvCacheInstalled");
  if (globalThis[flag] || typeof globalThis.fetch !== "function") return;
  globalThis.fetch = createXmltvCachingFetch(globalThis.fetch.bind(globalThis));
  globalThis[flag] = true;
}
