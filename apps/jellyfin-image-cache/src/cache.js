import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .trim();
}

function repairConcatenatedAbsoluteUrl(value) {
  const raw = String(value || "").trim();
  const first = raw.match(/^https?:\/\//i);
  if (!first) return raw;

  const rest = raw.slice(first[0].length);
  const secondRelative = rest.search(/https?:\/\//i);
  if (secondRelative < 0) return raw;
  const second = first[0].length + secondRelative;

  const boundaries = ["/", "?", "#"]
    .map((char) => raw.indexOf(char, first[0].length))
    .filter((index) => index >= 0);
  const firstBoundary = boundaries.length ? Math.min(...boundaries) : -1;

  // Observed bad XMLTV example:
  // https://television.telerama.frhttps://focus.telerama.fr/...png
  // Only repair when the second absolute scheme appears before a legitimate
  // path/query/fragment boundary. A nested URL in ?url=https://... is retained.
  if (firstBoundary < 0 || second < firstBoundary) return raw.slice(second);
  return raw;
}

function privateLiteralHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;

  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
  }
  if (family === 6) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host)) return true;
    if (/^fe[89ab]/.test(host)) return true;
    if (/^ff/.test(host)) return true;
  }
  return false;
}

export function normalizeRemoteImageUrl(value) {
  const raw = repairConcatenatedAbsoluteUrl(decodeEntities(value));
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (privateLiteralHost(url.hostname)) return "";
    if (url.username || url.password) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function imageToken(source) {
  return crypto.createHash("sha256").update(String(source)).digest("hex");
}

function sniffImageType(body) {
  if (!Buffer.isBuffer(body) || !body.length) return "";
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && /^GIF8[79]a$/.test(body.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (body.length >= 4 && body[0] === 0x00 && body[1] === 0x00 && body[2] === 0x01 && body[3] === 0x00) return "image/x-icon";
  if (body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp" && /^(?:avif|avis)$/.test(body.subarray(8, 12).toString("ascii"))) return "image/avif";
  const prefix = body.subarray(0, Math.min(body.length, 2048)).toString("utf8").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(prefix)) return "image/svg+xml";
  return "";
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf8");
  await fs.rename(tmp, file);
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) throw new Error(`image too large (${declared} bytes)`);

  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error(`image too large (${body.length} bytes)`);
    return body;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`image too large (${total} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export class ImageCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || "/var/cache/justone-images";
    this.ttlMs = Math.max(60_000, Number(options.ttlMs || 30 * 24 * 60 * 60 * 1000));
    this.negativeTtlMs = Math.max(60_000, Number(options.negativeTtlMs || 6 * 60 * 60 * 1000));
    this.fetchTimeoutMs = Math.max(1_000, Number(options.fetchTimeoutMs || 10_000));
    this.fetchConcurrency = Math.max(1, Math.min(16, Number(options.fetchConcurrency || 4)));
    this.maxBytes = Math.max(64 * 1024, Number(options.maxBytes || 8 * 1024 * 1024));
    this.missWaitMs = Math.max(0, Math.min(5_000, Number(options.missWaitMs ?? 250)));
    this.hostBackoffMs = Math.max(10_000, Number(options.hostBackoffMs || 15 * 60 * 1000));
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.sources = new Map();
    this.inflight = new Map();
    this.hostCooldowns = new Map();
    this.activeFetches = 0;
    this.waiters = [];
    this.stats = {
      registered: 0,
      hits: 0,
      misses: 0,
      stale: 0,
      negativeHits: 0,
      deferredMisses: 0,
      fetched: 0,
      failures: 0,
      fallback: 0,
      hostBackoffs: 0,
      bytes: 0,
    };
  }

  files(token) {
    const base = path.join(this.cacheDir, "data", token.slice(0, 2), token);
    return {
      body: `${base}.bin`,
      meta: `${base}.json`,
      source: path.join(this.cacheDir, "sources", `${token}.json`),
    };
  }

  register(value) {
    const source = normalizeRemoteImageUrl(value);
    if (!source) return null;
    const token = imageToken(source);
    if (!this.sources.has(token)) {
      this.sources.set(token, source);
      this.stats.registered += 1;
      void writeJsonAtomic(this.files(token).source, { source }).catch(() => {});
    }
    return { token, source };
  }

  async sourceFor(token) {
    if (this.sources.has(token)) return this.sources.get(token);
    const record = await readJson(this.files(token).source);
    const source = normalizeRemoteImageUrl(record?.source);
    if (!source || imageToken(source) !== token) return "";
    this.sources.set(token, source);
    return source;
  }

  async readRecord(token) {
    const files = this.files(token);
    const meta = await readJson(files.meta);
    let body = null;
    try {
      body = await fs.readFile(files.body);
    } catch {
      body = null;
    }
    return { files, meta, body };
  }

  async acquire() {
    if (this.activeFetches < this.fetchConcurrency) {
      this.activeFetches += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.activeFetches += 1;
  }

  release() {
    this.activeFetches = Math.max(0, this.activeFetches - 1);
    this.waiters.shift()?.();
  }

  cooldownHost(host, now) {
    const until = now + this.hostBackoffMs;
    const previous = this.hostCooldowns.get(host) || 0;
    if (until > previous) {
      this.hostCooldowns.set(host, until);
      this.stats.hostBackoffs += 1;
    }
  }

  hostCooldown(host, now) {
    const until = Number(this.hostCooldowns.get(host) || 0);
    if (!until) return 0;
    if (until <= now) {
      this.hostCooldowns.delete(host);
      return 0;
    }
    return until;
  }

  async safeFetch(source, now = Date.now()) {
    let current = source;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const safe = normalizeRemoteImageUrl(current);
      if (!safe) throw new Error("unsafe image URL");
      const parsed = new URL(safe);
      const host = parsed.host.toLowerCase();
      const coolingUntil = this.hostCooldown(host, now);
      if (coolingUntil) {
        throw new Error(`upstream image host cooling down until ${new Date(coolingUntil).toISOString()}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      let response;
      try {
        response = await this.fetchImpl(safe, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": "Mozilla/5.0 JustOne Jellyfin Image Cache",
            accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
        });
      } catch (error) {
        this.cooldownHost(host, now);
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`image redirect ${response.status} without location`);
        current = new URL(location, safe).href;
        continue;
      }

      if ([429, 500, 502, 503, 504].includes(response.status)) {
        this.cooldownHost(host, now);
      }
      return response;
    }
    throw new Error("too many image redirects");
  }

  async recordFailure(files, previous, source, error, now) {
    await writeJsonAtomic(files.meta, {
      ...(previous || {}),
      source,
      failureUntil: now + this.negativeTtlMs,
      failureReason: String(error?.message || error).slice(0, 500),
      lastFailureAt: now,
    }).catch(() => {});
  }

  async fetchAndStore(token, source, now = Date.now()) {
    if (this.inflight.has(token)) return this.inflight.get(token);
    const task = (async () => {
      const before = await this.readRecord(token);
      await this.acquire();
      try {
        const response = await this.safeFetch(source, now);
        if (!response.ok) throw new Error(`upstream image ${response.status}`);
        const body = await readLimitedBody(response, this.maxBytes);
        const contentType = sniffImageType(body);
        if (!contentType) throw new Error("upstream response is not a supported image");

        await fs.mkdir(path.dirname(before.files.body), { recursive: true });
        const tmp = `${before.files.body}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, before.files.body);
        await writeJsonAtomic(before.files.meta, {
          source,
          contentType,
          fetchedAt: now,
          bytes: body.length,
          failureUntil: 0,
          failureReason: "",
        });
        this.stats.fetched += 1;
        this.stats.bytes += body.length;
        return { body, contentType, state: "miss" };
      } catch (error) {
        this.stats.failures += 1;
        const latest = await this.readRecord(token);
        await this.recordFailure(latest.files, latest.meta || before.meta, source, error, now);
        throw error;
      } finally {
        this.release();
      }
    })();

    this.inflight.set(token, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(token);
    }
  }

  fallback(reason = "unavailable") {
    this.stats.fallback += 1;
    return { body: PLACEHOLDER_PNG, contentType: "image/png", state: "fallback", reason };
  }

  async boundedFirstFetch(task) {
    if (this.missWaitMs <= 0) {
      this.stats.deferredMisses += 1;
      void task.catch(() => {});
      return this.fallback("warming");
    }

    let timer;
    const outcome = await Promise.race([
      task.then(
        (value) => ({ type: "value", value }),
        (error) => ({ type: "error", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ type: "timeout" }), this.missWaitMs);
      }),
    ]);
    clearTimeout(timer);

    if (outcome.type === "value") return outcome.value;
    if (outcome.type === "error") return this.fallback(String(outcome.error?.message || outcome.error));

    this.stats.deferredMisses += 1;
    void task.catch(() => {});
    return this.fallback("warming");
  }

  async get(token, now = Date.now()) {
    const key = String(token || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(key)) return this.fallback("invalid-token");
    const source = await this.sourceFor(key);
    if (!source) return this.fallback("unknown-token");

    const record = await this.readRecord(key);
    const fetchedAt = Number(record.meta?.fetchedAt || 0);
    const failureUntil = Number(record.meta?.failureUntil || 0);
    const contentType = record.meta?.contentType || (record.body ? sniffImageType(record.body) : "");

    if (record.body?.length && contentType) {
      if (fetchedAt && now - fetchedAt <= this.ttlMs) {
        this.stats.hits += 1;
        return { body: record.body, contentType, state: "hit" };
      }
      this.stats.stale += 1;
      if (now >= failureUntil && !this.inflight.has(key)) {
        void this.fetchAndStore(key, source, now).catch(() => {});
      }
      return { body: record.body, contentType, state: "stale" };
    }

    if (failureUntil && now < failureUntil) {
      this.stats.negativeHits += 1;
      return this.fallback(record.meta?.failureReason || "negative-cache");
    }

    this.stats.misses += 1;
    return this.boundedFirstFetch(this.fetchAndStore(key, source, now));
  }

  snapshot(now = Date.now()) {
    for (const [host, until] of this.hostCooldowns) {
      if (until <= now) this.hostCooldowns.delete(host);
    }
    return {
      ...this.stats,
      knownSources: this.sources.size,
      inflight: this.inflight.size,
      activeFetches: this.activeFetches,
      queuedFetches: this.waiters.length,
      hostCooldowns: this.hostCooldowns.size,
      fetchConcurrency: this.fetchConcurrency,
      missWaitMs: this.missWaitMs,
      hostBackoffMs: this.hostBackoffMs,
      ttlHours: Math.round((this.ttlMs / 3_600_000) * 10) / 10,
      negativeTtlHours: Math.round((this.negativeTtlMs / 3_600_000) * 10) / 10,
      maxBytes: this.maxBytes,
    };
  }
}
