import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, withKey } from "./config.js";

const sources = new Map();
const inflight = new Map();
const stats = {
  registered: 0,
  hits: 0,
  misses: 0,
  stale: 0,
  negativeHits: 0,
  fetched: 0,
  failures: 0,
  bytes: 0,
};

let activeFetches = 0;
const fetchWaiters = [];

function decodeUrlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .trim();
}

function repairConcatenatedScheme(value) {
  const raw = String(value || "").trim();
  const first = raw.search(/https?:\/\//i);
  if (first !== 0) return raw;
  const rest = raw.slice(raw.match(/^https?:\/\//i)?.[0]?.length || 0);
  const offset = rest.search(/https?:\/\//i);
  if (offset < 0) return raw;
  const absoluteSecond = (raw.match(/^https?:\/\//i)?.[0]?.length || 0) + offset;
  const prefix = raw.slice(0, absoluteSecond);
  const afterAuthority = prefix.replace(/^https?:\/\//i, "");
  // Repair the observed EPG defect where two absolute URLs are concatenated
  // directly at the hostname boundary, e.g. https://a.examplehttps://b.example/x.png.
  // Do not rewrite legitimate query/path values which themselves contain URLs.
  if (!/[/?#]/.test(afterAuthority)) return raw.slice(absoluteSecond);
  return raw;
}

export function normalizeRemoteImageUrl(value) {
  let raw = repairConcatenatedScheme(decodeUrlEntities(value));
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    if (/^(?:localhost|0\.0\.0\.0)$/i.test(url.hostname)) return "";
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return "";
    const private172 = /^172\.(\d{1,3})\./.exec(url.hostname);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function tokenForSource(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function cachePaths(token) {
  const base = path.join(config.imageCacheDir, "data", token.slice(0, 2), token);
  return {
    body: `${base}.bin`,
    meta: `${base}.json`,
    source: path.join(config.imageCacheDir, "sources", `${token}.json`),
  };
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf8");
  await fs.rename(tmp, file);
}

async function persistSource(token, source) {
  const files = cachePaths(token);
  await writeJsonAtomic(files.source, { source });
}

async function loadSource(token) {
  const known = sources.get(token);
  if (known) return known;
  try {
    const raw = JSON.parse(await fs.readFile(cachePaths(token).source, "utf8"));
    const source = normalizeRemoteImageUrl(raw?.source);
    if (!source || tokenForSource(source) !== token) return "";
    sources.set(token, source);
    return source;
  } catch {
    return "";
  }
}

function isLocalJustOneImage(value) {
  try {
    const candidate = new URL(String(value || ""));
    const base = new URL(config.publicUrl);
    return candidate.host === base.host
      && /^\/jellyfin\/(?:image|artwork)\//i.test(candidate.pathname);
  } catch {
    return false;
  }
}

function fallbackArtworkUrl(variant, channelId) {
  if (!channelId) return "";
  const kind = variant === "channel" ? "channel" : "program";
  return withKey(`${config.publicUrl}/jellyfin/artwork/${kind}/${encodeURIComponent(channelId)}.png`);
}

export function cachedImageUrl(value, { variant = "channel", channelId = "" } = {}) {
  const original = String(value || "").trim();
  if (isLocalJustOneImage(original)) return original;
  const source = normalizeRemoteImageUrl(original);
  if (!source) return fallbackArtworkUrl(variant, channelId);

  const token = tokenForSource(source);
  if (!sources.has(token)) stats.registered += 1;
  sources.set(token, source);
  // The in-memory registration makes the route immediately usable; persistence
  // lets the same hash resolve after restarts even before the next guide refresh.
  void persistSource(token, source).catch(() => {});

  const url = new URL(`${config.publicUrl}/jellyfin/image/${token}`);
  if (channelId) {
    url.searchParams.set("fv", variant === "channel" ? "channel" : "program");
    url.searchParams.set("fi", String(channelId));
  }
  return withKey(url.href);
}

export function localizeLineupImages(lineup = []) {
  for (const channel of lineup) {
    if (!channel) continue;
    const current = String(channel.logo || "").trim();
    if (!current || isLocalJustOneImage(current)) continue;
    const localized = cachedImageUrl(current, { variant: "channel", channelId: channel.id });
    if (localized) {
      channel.logoOriginal = current;
      channel.logo = localized;
    }
  }
  return lineup;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function localizeProgramBlock(block, channelId) {
  const options = { variant: "program", channelId };
  let out = block.replace(/(<icon\b[^>]*\bsrc=")([^"]+)(")/gi, (_m, a, value, b) => {
    const localized = cachedImageUrl(value, options);
    return `${a}${xmlEscape(localized || fallbackArtworkUrl("program", channelId))}${b}`;
  });
  out = out.replace(/(<image\b[^>]*>)([^<]+)(<\/image>)/gi, (_m, a, value, b) => {
    const localized = cachedImageUrl(value, options);
    return `${a}${xmlEscape(localized || fallbackArtworkUrl("program", channelId))}${b}`;
  });
  return out;
}

export function localizeXmlTvImages(xml, lineup = []) {
  const byTvgId = new Map((lineup || []).map((channel) => [String(channel?.tvgId || ""), channel]));
  let out = String(xml || "");

  // Channel logos have already been localized on the lineup in normal operation,
  // but this also protects direct buildXmlTv callers and malformed guide icons.
  out = out.replace(/(<channel\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<icon\b[^>]*\bsrc=")([^"]+)(")/gi,
    (_m, a, tvgId, value, b) => {
      const channel = byTvgId.get(tvgId);
      const localized = cachedImageUrl(value, { variant: "channel", channelId: channel?.id || "" });
      return `${a}${xmlEscape(localized || fallbackArtworkUrl("channel", channel?.id || ""))}${b}`;
    });

  out = out.replace(/<programme\b[^>]*\bchannel="([^"]+)"[^>]*>[\s\S]*?<\/programme>/gi, (block, tvgId) => {
    const channel = byTvgId.get(tvgId);
    return localizeProgramBlock(block, channel?.id || "");
  });
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readRecord(token) {
  const files = cachePaths(token);
  const meta = await readJson(files.meta);
  let body = null;
  try {
    body = await fs.readFile(files.body);
  } catch {
    body = null;
  }
  return { files, meta, body };
}

function sniffImageType(body, header) {
  const contentType = String(header || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType.startsWith("image/")) return contentType;
  if (!Buffer.isBuffer(body) || !body.length) return "";
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && /GIF8[79]a/.test(body.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const prefix = body.subarray(0, Math.min(body.length, 1024)).toString("utf8").trimStart();
  if (/^(?:<\?xml[\s\S]*?)?<svg\b/i.test(prefix)) return "image/svg+xml";
  return "";
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > config.imageCacheMaxBytes) throw new Error(`image too large (${declared} bytes)`);
  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > config.imageCacheMaxBytes) throw new Error(`image too large (${body.length} bytes)`);
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > config.imageCacheMaxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`image too large (${total} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function acquireFetchSlot() {
  if (activeFetches < config.imageCacheFetchConcurrency) {
    activeFetches += 1;
    return;
  }
  await new Promise((resolve) => fetchWaiters.push(resolve));
  activeFetches += 1;
}

function releaseFetchSlot() {
  activeFetches = Math.max(0, activeFetches - 1);
  fetchWaiters.shift()?.();
}

async function recordFailure(files, priorMeta, source, error, now) {
  const meta = {
    ...(priorMeta || {}),
    source,
    failureUntil: now + config.imageCacheNegativeTtlMs,
    failureReason: String(error?.message || error).slice(0, 500),
    lastFailureAt: now,
  };
  await writeJsonAtomic(files.meta, meta).catch(() => {});
}

async function fetchAndStore(token, source, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (inflight.has(token)) return inflight.get(token);
  const task = (async () => {
    const { files, meta: priorMeta } = await readRecord(token);
    await acquireFetchSlot();
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), config.imageCacheFetchTimeoutMs);
      const response = await fetchImpl(source, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 JustOne Jellyfin Image Cache",
          accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      if (!response.ok) throw new Error(`upstream image ${response.status}`);
      const body = await readLimitedBody(response);
      const contentType = sniffImageType(body, response.headers.get("content-type"));
      if (!contentType) throw new Error("upstream response is not an image");

      await fs.mkdir(path.dirname(files.body), { recursive: true });
      const tmp = `${files.body}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, files.body);
      const meta = {
        source,
        contentType,
        fetchedAt: now,
        bytes: body.length,
        failureUntil: 0,
        failureReason: "",
      };
      await writeJsonAtomic(files.meta, meta);
      stats.fetched += 1;
      stats.bytes += body.length;
      return { body, contentType, state: "miss" };
    } catch (error) {
      stats.failures += 1;
      const { files, meta: latestMeta } = await readRecord(token);
      await recordFailure(files, latestMeta || priorMeta, source, error, now);
      throw error;
    } finally {
      clearTimeout(timer);
      releaseFetchSlot();
    }
  })();
  inflight.set(token, task);
  try {
    return await task;
  } finally {
    inflight.delete(token);
  }
}

export async function getCachedImage(token, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const key = String(token || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid image token");
  const source = await loadSource(key);
  if (!source) throw new Error("unknown image token");

  const record = await readRecord(key);
  const fetchedAt = Number(record.meta?.fetchedAt || 0);
  const failureUntil = Number(record.meta?.failureUntil || 0);
  if (record.body?.length) {
    const contentType = record.meta?.contentType || sniffImageType(record.body, "");
    if (fetchedAt && now - fetchedAt <= config.imageCacheTtlMs) {
      stats.hits += 1;
      return { body: record.body, contentType, state: "hit" };
    }
    stats.stale += 1;
    if (now >= failureUntil && !inflight.has(key)) {
      void fetchAndStore(key, source, { fetchImpl, now }).catch(() => {});
    }
    return { body: record.body, contentType, state: "stale" };
  }

  if (failureUntil && now < failureUntil) {
    stats.negativeHits += 1;
    throw new Error(record.meta?.failureReason || "image source temporarily unavailable");
  }
  stats.misses += 1;
  return fetchAndStore(key, source, { fetchImpl, now });
}

export function imageCacheStats() {
  return {
    ...stats,
    knownSources: sources.size,
    inflight: inflight.size,
    activeFetches,
    fetchConcurrency: config.imageCacheFetchConcurrency,
    ttlHours: Math.round((config.imageCacheTtlMs / 3600000) * 10) / 10,
    negativeTtlHours: Math.round((config.imageCacheNegativeTtlMs / 3600000) * 10) / 10,
    maxBytes: config.imageCacheMaxBytes,
    directory: config.imageCacheDir,
  };
}

export function resetImageCacheForTests() {
  sources.clear();
  inflight.clear();
  for (const key of Object.keys(stats)) stats[key] = 0;
  activeFetches = 0;
  fetchWaiters.splice(0);
}
