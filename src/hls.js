import crypto from "node:crypto";

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIVE_EDGE_SEGMENTS = 3;

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function sleep(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(1, Number(ms) || 1));
    timer.unref?.();
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

function parseAttributeList(value) {
  const out = {};
  const raw = String(value || "");
  let current = "";
  let quoted = false;
  const parts = [];
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toUpperCase();
    let val = part.slice(index + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function resolveUri(uri, baseUrl) {
  return new URL(String(uri || "").trim(), baseUrl).toString();
}

function sequenceIv(sequence) {
  let value = BigInt(Math.max(0, Number(sequence) || 0));
  const iv = Buffer.alloc(16);
  for (let i = 15; i >= 0; i -= 1) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

function parseIv(value, sequence) {
  const raw = String(value || "").trim();
  if (!raw) return sequenceIv(sequence);
  const hex = raw.replace(/^0x/i, "").padStart(32, "0").slice(-32);
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid HLS AES-128 IV");
  return Buffer.from(hex, "hex");
}

export function isHlsResponse(response, candidateUrl = "") {
  const type = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  const requested = String(candidateUrl || "").toLowerCase();
  const finalUrl = String(response?.url || "").toLowerCase();
  return type.includes("mpegurl")
    || /\.m3u8(?:$|[?#])/.test(requested)
    || /\.m3u8(?:$|[?#])/.test(finalUrl);
}

export function parseHlsPlaylist(text, baseUrl) {
  const body = String(text || "").replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines[0] !== "#EXTM3U") throw new Error("invalid HLS playlist");

  const variants = [];
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = 6;
  let endList = false;
  let pendingVariant = null;
  let pendingDuration = null;
  let currentKey = null;
  let pendingByteRange = null;
  let nextByteRangeOffset = 0;
  let sawMap = false;

  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const parsed = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      if (Number.isFinite(parsed) && parsed >= 0) mediaSequence = Math.floor(parsed);
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const parsed = Number(line.slice("#EXT-X-TARGETDURATION:".length));
      if (Number.isFinite(parsed) && parsed > 0) targetDuration = parsed;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const parsed = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pendingDuration = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      sawMap = true;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-KEY:".length));
      const method = String(attrs.METHOD || "").toUpperCase();
      if (!method || method === "NONE") {
        currentKey = null;
      } else if (method === "AES-128" && attrs.URI) {
        currentKey = { method, uri: resolveUri(attrs.URI, baseUrl), iv: attrs.IV || "" };
      } else {
        currentKey = { method, unsupported: true };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const raw = line.slice("#EXT-X-BYTERANGE:".length);
      const [lengthRaw, offsetRaw] = raw.split("@");
      const length = Number(lengthRaw);
      const offset = offsetRaw == null ? nextByteRangeOffset : Number(offsetRaw);
      if (Number.isFinite(length) && length > 0 && Number.isFinite(offset) && offset >= 0) {
        pendingByteRange = { length: Math.floor(length), offset: Math.floor(offset) };
        nextByteRangeOffset = Math.floor(offset + length);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    if (pendingVariant) {
      variants.push({
        url: resolveUri(line, baseUrl),
        bandwidth: Number(pendingVariant.BANDWIDTH || 0),
        averageBandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"] || 0),
        codecs: pendingVariant.CODECS || "",
        resolution: pendingVariant.RESOLUTION || "",
      });
      pendingVariant = null;
      continue;
    }

    const sequence = mediaSequence + segments.length;
    segments.push({
      url: resolveUri(line, baseUrl),
      sequence,
      duration: pendingDuration,
      key: currentKey ? { ...currentKey } : null,
      byteRange: pendingByteRange ? { ...pendingByteRange } : null,
    });
    pendingDuration = null;
    pendingByteRange = null;
  }

  return {
    master: variants.length > 0,
    variants,
    segments,
    mediaSequence,
    targetDuration,
    endList,
    sawMap,
  };
}

async function readBodyLimited(response, maxBytes = DEFAULT_MAX_PLAYLIST_BYTES) {
  if (!response.body) throw new Error("HLS response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value?.byteLength) continue;
      total += part.value.byteLength;
      if (total > maxBytes) throw new Error(`HLS playlist exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function chooseMasterVariant(variants) {
  return [...variants].sort((a, b) => {
    const ab = Number(a.averageBandwidth || a.bandwidth || 0);
    const bb = Number(b.averageBandwidth || b.bandwidth || 0);
    return bb - ab;
  })[0] || null;
}

export class HlsMpegTsReader {
  static async create({
    fetchImpl,
    initialResponse,
    candidateUrl,
    signal,
    userAgent,
    liveEdgeSegments = DEFAULT_LIVE_EDGE_SEGMENTS,
    maxPlaylistBytes = DEFAULT_MAX_PLAYLIST_BYTES,
  }) {
    const reader = new HlsMpegTsReader({
      fetchImpl,
      signal,
      userAgent,
      liveEdgeSegments,
      maxPlaylistBytes,
    });
    await reader.#initialize(initialResponse, candidateUrl);
    return reader;
  }

  constructor({
    fetchImpl,
    signal,
    userAgent,
    liveEdgeSegments,
    maxPlaylistBytes,
  }) {
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.userAgent = userAgent;
    this.liveEdgeSegments = Math.max(1, Number(liveEdgeSegments) || DEFAULT_LIVE_EDGE_SEGMENTS);
    this.maxPlaylistBytes = Math.max(64 * 1024, Number(maxPlaylistBytes) || DEFAULT_MAX_PLAYLIST_BYTES);
    this.playlistUrl = "";
    this.pending = [];
    this.seen = new Set();
    this.endList = false;
    this.targetDuration = 6;
    this.currentReader = null;
    this.currentController = null;
    this.cancelled = false;
    this.initialized = false;
    this.keyCache = new Map();
  }

  async #initialize(initialResponse, candidateUrl) {
    throwIfAborted(this.signal);
    const base = initialResponse.url || candidateUrl;
    const text = await readBodyLimited(initialResponse, this.maxPlaylistBytes);
    let parsed = parseHlsPlaylist(text, base);

    if (parsed.master) {
      const variant = chooseMasterVariant(parsed.variants);
      if (!variant) throw new Error("HLS master playlist has no playable variants");
      this.playlistUrl = variant.url;
      const response = await this.#fetchPlaylist(this.playlistUrl);
      const mediaText = await readBodyLimited(response, this.maxPlaylistBytes);
      parsed = parseHlsPlaylist(mediaText, response.url || this.playlistUrl);
      if (parsed.master) throw new Error("nested HLS master playlists are not supported");
      this.playlistUrl = response.url || this.playlistUrl;
    } else {
      this.playlistUrl = base;
    }

    this.#applyMediaPlaylist(parsed, true);
    this.initialized = true;
  }

  #segmentKey(segment) {
    return Number.isFinite(Number(segment.sequence))
      ? `seq:${segment.sequence}`
      : `url:${segment.url}`;
  }

  #applyMediaPlaylist(parsed, initial = false) {
    if (parsed.sawMap) throw new Error("fMP4 HLS is not supported by the MPEG-TS relay");
    const unsupported = parsed.segments.find((segment) => segment.key?.unsupported);
    if (unsupported) {
      throw new Error(`HLS encryption method ${unsupported.key.method || "unknown"} is not supported`);
    }

    this.targetDuration = Math.max(1, Number(parsed.targetDuration || this.targetDuration || 6));
    this.endList = parsed.endList === true;

    let segments = parsed.segments || [];
    if (initial && !this.endList && segments.length > this.liveEdgeSegments) {
      segments = segments.slice(-this.liveEdgeSegments);
    }

    for (const segment of segments) {
      const key = this.#segmentKey(segment);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.push(segment);
    }

    // Prevent unbounded sequence history on long-running channels.
    if (this.seen.size > 4096 && segments.length) {
      const floor = Math.min(...segments.map((segment) => Number(segment.sequence)).filter(Number.isFinite));
      if (Number.isFinite(floor)) {
        for (const key of [...this.seen]) {
          const match = /^seq:(\d+)$/.exec(key);
          if (match && Number(match[1]) < floor - 32) this.seen.delete(key);
        }
      }
    }
  }

  async #fetch(url, init = {}) {
    throwIfAborted(this.signal);
    const headers = {
      accept: "*/*",
      "accept-encoding": "identity",
      "user-agent": this.userAgent,
      ...(init.headers || {}),
    };
    return await this.fetchImpl(url, {
      ...init,
      redirect: "follow",
      signal: this.signal,
      headers,
    });
  }

  async #fetchPlaylist(url) {
    const response = await this.#fetch(url, {
      headers: { accept: "application/vnd.apple.mpegurl,application/x-mpegURL,audio/mpegurl,*/*" },
    });
    if (!response.ok) throw new Error(`HLS playlist HTTP ${response.status}`);
    return response;
  }

  async #refreshPlaylist() {
    const response = await this.#fetchPlaylist(this.playlistUrl);
    const text = await readBodyLimited(response, this.maxPlaylistBytes);
    const parsed = parseHlsPlaylist(text, response.url || this.playlistUrl);
    if (parsed.master) throw new Error("HLS media playlist changed into a master playlist");
    this.playlistUrl = response.url || this.playlistUrl;
    this.#applyMediaPlaylist(parsed, false);
  }

  async #getKey(keyInfo, sequence) {
    const cacheKey = keyInfo.uri;
    let key = this.keyCache.get(cacheKey);
    if (!key) {
      const response = await this.#fetch(keyInfo.uri);
      if (!response.ok) throw new Error(`HLS AES-128 key HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== 16) throw new Error(`HLS AES-128 key must be 16 bytes, got ${body.length}`);
      key = body;
      this.keyCache.set(cacheKey, key);
    }
    return { key, iv: parseIv(keyInfo.iv, sequence) };
  }

  async #openSegment(segment) {
    const headers = {};
    if (segment.byteRange) {
      const start = segment.byteRange.offset;
      const end = start + segment.byteRange.length - 1;
      headers.range = `bytes=${start}-${end}`;
    }

    const response = await this.#fetch(segment.url, { headers });
    if (!response.ok) {
      const error = new Error(`HLS segment HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!response.body) throw new Error("HLS segment has no body");

    if (segment.key?.method === "AES-128") {
      const encrypted = Buffer.from(await response.arrayBuffer());
      const { key, iv } = await this.#getKey(segment.key, segment.sequence);
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return {
        read: (() => {
          let sent = false;
          return async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: decrypted };
          };
        })(),
        cancel: async () => {},
      };
    }

    return response.body.getReader();
  }

  async read() {
    if (this.cancelled) return { done: true, value: undefined };
    throwIfAborted(this.signal);

    while (!this.cancelled) {
      if (this.currentReader) {
        const part = await this.currentReader.read();
        if (!part.done) return part;
        try { await this.currentReader.cancel(); } catch {}
        this.currentReader = null;
        continue;
      }

      if (this.pending.length) {
        const segment = this.pending.shift();
        try {
          this.currentReader = await this.#openSegment(segment);
          continue;
        } catch (error) {
          // A live edge can race playlist expiry. Refresh on gone/missing
          // segments instead of failing the whole provider immediately.
          if ([404, 410].includes(Number(error?.status || 0))) {
            await this.#refreshPlaylist();
            continue;
          }
          throw error;
        }
      }

      if (this.endList) return { done: true, value: undefined };

      await this.#refreshPlaylist();
      if (this.pending.length) continue;

      const pollMs = Math.max(250, Math.min(3000, Math.round(this.targetDuration * 500)));
      await sleep(pollMs, this.signal);
    }

    return { done: true, value: undefined };
  }

  async cancel() {
    this.cancelled = true;
    if (this.currentReader) {
      try { await this.currentReader.cancel(); } catch {}
      this.currentReader = null;
    }
  }
}
