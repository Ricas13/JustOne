export function liveBufferSettings(env = process.env) {
  const seconds = Math.max(0, Math.min(30, Number(env.LIVE_BUFFER_SECONDS ?? 5)));
  const maxBytes = Math.max(
    1024 * 1024,
    Number(env.LIVE_BUFFER_MAX_BYTES || 64 * 1024 * 1024),
  );
  return {
    seconds,
    delayMs: Math.round(seconds * 1000),
    maxBytes,
  };
}

export class StartupMediaBuffer {
  constructor(maxBytes) {
    this.maxBytes = Math.max(1, Number(maxBytes || 1));
    this.chunks = [];
    this.bytes = 0;
    this.released = false;
  }

  push(chunk) {
    if (this.released) return { accepted: false, full: true };
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(data);
    this.bytes += data.length;
    return { accepted: true, full: this.bytes >= this.maxBytes };
  }

  release() {
    if (this.released) return Buffer.alloc(0);
    this.released = true;
    const out = this.chunks.length === 1
      ? this.chunks[0]
      : Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  clear() {
    this.released = true;
    this.chunks = [];
    this.bytes = 0;
  }
}
