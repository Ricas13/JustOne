import crypto from "node:crypto";

const DEFAULT_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 128 * 1024 * 1024;
const DEFAULT_LIVE_EDGE_SEGMENTS = 3;
const DEFAULT_PACING_SLICE_MS = 50;
const MIN_PACED_SEGMENT_BYTES = 64 * 1024;

function hlsError(message, { code = "hls_error", status = 0 } = {}) {
  const error = new Error(message);
  error.name = "HlsError";
  error.code = code;
  error.status = Number(status || 0);
  return error;
}

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
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const timer = setTimeout(() => finish(resolve), Math.max(1, Number(ms) || 1));
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      finish(reject, abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
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
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw hlsError("invalid HLS AES-128 IV", { code: "hls_invalid" });
  return Buffer.from(hex, "hex");
}

async function readResponseBuffer(response, maxBytes = DEFAULT_MAX_SEGMENT_BYTES) {
  if (!response.body) throw hlsError("HLS segment has no body", { code: "hls_invalid" });
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value?.byteLength) continue;
      total += part.value.byteLength;
      if (total > maxBytes) throw hlsError(`HLS segment exceeds ${maxBytes} bytes`, { code: "hls_invalid" });
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

function pacedBufferReader(buffer, {
  durationMs,
  alreadyElapsedMs = 0,
  signal,
  sliceMs = DEFAULT_PACING_SLICE_MS,
  now = () => Date.now(),
} = {}) {
  const data = Buffer.from(buffer || []);
  const budgetMs = Math.max(0, Number(durationMs || 0) - Math.max(0, Number(alreadyElapsedMs || 0)));
  const startedAt = now();
  const packetSize = 188;
  const slices = budgetMs > 0 ? Math.max(1, Math.ceil(budgetMs / Math.max(10, sliceMs))) : 1;
  const packets = Math.max(1, Math.ceil(data.length / packetSize));
  const packetsPerSlice = Math.max(1, Math.ceil(packets / slices));
  const chunkSize = packetsPerSlice * packetSize;
  let offset = 0;
  let cancelled = false;

  return {
    async read() {
      if (cancelled) return { done: true, value: undefined };
      throwIfAborted(signal);
      if (offset >= data.length) {
        const remaining = startedAt + budgetMs - now();
        if (remaining > 0) await sleep(remaining, signal);
        return { done: true, value: undefined };
      }

      if (budgetMs > 0 && offset > 0) {
        const target = startedAt + Math.round(budgetMs * (offset / data.length));
        const waitMs = target - now();
        if (waitMs > 0) await sleep(waitMs, signal);
      }

      const end = Math.min(data.length, offset + chunkSize);
      const value = data.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    async cancel() {
      cancelled = true;
    },
  };
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
  if (!lines.length || lines[0] !== "#EXTM3U") throw hlsError("invalid HLS playlist", { code: "hls_invalid" });

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
      if (total > maxBytes) throw hlsError(`HLS playlist exceeds ${maxBytes} bytes`, { code: "hls_invalid" });
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function orderedMasterVariants(variants) {
  return [...variants].sort((a, b) => {
    const ab = Number(a.averageBandwidth || a.bandwidth || 0);
    const bb = Number(b.averageBandwidth || b.bandwidth || 0);
    return bb - ab;
  });
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
    this.metadata = {
      master: false,
      codecs: "",
      resolution: "",
      bandwidth: 0,
      averageBandwidth: 0,
      encryption: "",
      pacing: false,
      lastSegmentDurationMs: 0,
      lastSegmentDownloadMs: 0,
      lastSegmentBytes: 0,
    };
  }

  async #initialize(initialResponse, candidateUrl) {
    throwIfAborted(this.signal);
    const base = initialResponse.url || candidateUrl;
    const text = await readBodyLimited(initialResponse, this.maxPlaylistBytes);
    let parsed = parseHlsPlaylist(text, base);

    if (parsed.master) {
      const variants = orderedMasterVariants(parsed.variants);
      if (!variants.length) throw hlsError("HLS master playlist has no playable variants", { code: "hls_invalid" });
      let lastUnsupported = null;
      for (const variant of variants) {
        const variantUrl = variant.url;
        const response = await this.#fetchPlaylist(variantUrl);
        const mediaText = await readBodyLimited(response, this.maxPlaylistBytes);
        const media = parseHlsPlaylist(mediaText, response.url || variantUrl);
        if (media.master) {
          lastUnsupported = hlsError("nested HLS master playlists are not supported", { code: "hls_unsupported" });
          continue;
        }
        try {
          this.playlistUrl = response.url || variantUrl;
          this.#applyMediaPlaylist(media, true);
          this.metadata = {
            ...this.metadata,
            master: true,
            codecs: variant.codecs || "",
            resolution: variant.resolution || "",
            bandwidth: Number(variant.bandwidth || 0),
            averageBandwidth: Number(variant.averageBandwidth || 0),
            encryption: media.segments.find((segment) => segment.key?.method)?.key?.method || "",
          };
          this.initialized = true;
          return;
        } catch (error) {
          if (error?.code !== "hls_unsupported") throw error;
          lastUnsupported = error;
          this.pending = [];
          this.seen.clear();
        }
      }
      throw lastUnsupported || hlsError("HLS master playlist has no relayable MPEG-TS rendition", { code: "hls_unsupported" });
    }

    this.playlistUrl = base;
    this.#applyMediaPlaylist(parsed, true);
    this.metadata = {
      ...this.metadata,
      master: false,
      codecs: "",
      resolution: "",
      bandwidth: 0,
      averageBandwidth: 0,
      encryption: parsed.segments.find((segment) => segment.key?.method)?.key?.method || "",
    };
    this.initialized = true;
  }

  #segmentKey(segment) {
    return Number.isFinite(Number(segment.sequence))
      ? `seq:${segment.sequence}`
      : `url:${segment.url}`;
  }

  #applyMediaPlaylist(parsed, initial = false) {
    if (parsed.sawMap) throw hlsError("fMP4 HLS is not supported by the MPEG-TS relay", { code: "hls_unsupported" });
    const unsupported = parsed.segments.find((segment) => segment.key?.unsupported);
    if (unsupported) {
      throw hlsError(`HLS encryption method ${unsupported.key.method || "unknown"} is not supported`, { code: "hls_unsupported" });
    }

    this.targetDuration = Math.max(1, Number(parsed.targetDuration || this.targetDuration || 6));
    this.endList = parsed.endList === true;

    const allSegments = parsed.segments || [];
    let segments = allSegments;

    if (initial && !this.endList && allSegments.length > this.liveEdgeSegments) {
      // Mark the whole initial playlist window as seen so the first refresh
      // cannot enqueue older pre-live-edge segments and play backwards.
      for (const segment of allSegments) this.seen.add(this.#segmentKey(segment));
      segments = allSegments.slice(-this.liveEdgeSegments);
      this.pending.push(...segments.map((segment) => ({ ...segment, live: true })));
    } else {
      for (const segment of segments) {
        const key = this.#segmentKey(segment);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.pending.push({ ...segment, live: !this.endList });
      }
    }

    // Prevent unbounded sequence history on long-running channels.
    if (this.seen.size > 4096 && allSegments.length) {
      const floor = Math.min(...allSegments.map((segment) => Number(segment.sequence)).filter(Number.isFinite));
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
    if (!response.ok) throw hlsError(`HLS playlist HTTP ${response.status}`, { code: "hls_http", status: response.status });
    return response;
  }

  async #refreshPlaylist() {
    const response = await this.#fetchPlaylist(this.playlistUrl);
    const text = await readBodyLimited(response, this.maxPlaylistBytes);
    const parsed = parseHlsPlaylist(text, response.url || this.playlistUrl);
    if (parsed.master) throw hlsError("HLS media playlist changed into a master playlist", { code: "hls_invalid" });
    this.playlistUrl = response.url || this.playlistUrl;
    this.#applyMediaPlaylist(parsed, false);
  }

  async #getKey(keyInfo, sequence) {
    const cacheKey = keyInfo.uri;
    let key = this.keyCache.get(cacheKey);
    if (!key) {
      const response = await this.#fetch(keyInfo.uri);
      if (!response.ok) throw hlsError(`HLS AES-128 key HTTP ${response.status}`, { code: "hls_http", status: response.status });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== 16) throw hlsError(`HLS AES-128 key must be 16 bytes, got ${body.length}`, { code: "hls_invalid" });
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

    const fetchStartedAt = Date.now();
    const response = await this.#fetch(segment.url, { headers });
    if (!response.ok) {
      const error = new Error(`HLS segment HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (segment.byteRange && response.status !== 206) {
      const error = new Error(`HLS byte-range segment expected HTTP 206, got ${response.status}`);
      error.status = response.status;
      throw error;
    }

    let body = await readResponseBuffer(response);
    if (segment.key?.method === "AES-128") {
      const { key, iv } = await this.#getKey(segment.key, segment.sequence);
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
      body = Buffer.concat([decipher.update(body), decipher.final()]);
    }

    if (!segment.live || !Number.isFinite(Number(segment.duration)) || Number(segment.duration) <= 0) {
      return pacedBufferReader(body, { durationMs: 0, signal: this.signal });
    }

    const downloadMs = Math.max(0, Date.now() - fetchStartedAt);
    const durationMs = Math.max(1, Number(segment.duration) * 1000);
    this.metadata.lastSegmentDurationMs = durationMs;
    this.metadata.lastSegmentDownloadMs = downloadMs;
    this.metadata.lastSegmentBytes = body.length;
    this.metadata.pacing = body.length >= MIN_PACED_SEGMENT_BYTES;

    if (!this.metadata.pacing) {
      return pacedBufferReader(body, { durationMs: 0, signal: this.signal });
    }

    return pacedBufferReader(body, {
      durationMs,
      alreadyElapsedMs: downloadMs,
      signal: this.signal,
    });
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
