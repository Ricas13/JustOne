const TS_PACKET_SIZE = 188;
const PCR_WRAP_TICKS = 2 ** 33;
const PCR_STARTUP_GRACE_MS = 750;
const PCR_MAX_STEP_MS = 5000;
const TS_BATCH_PACKETS = 7;

export function liveBufferSettings(env = process.env) {
  const seconds = Math.max(0, Math.min(30, Number(env.LIVE_BUFFER_SECONDS ?? 2)));
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

/** Read a 90 kHz MPEG-TS PCR base from one 188-byte transport packet. */
export function extractPcrFromPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < TS_PACKET_SIZE || packet[0] !== 0x47) {
    return null;
  }

  const adaptationControl = (packet[3] >> 4) & 0x03;
  if (adaptationControl !== 2 && adaptationControl !== 3) return null;

  const adaptationLength = packet[4];
  if (adaptationLength < 7 || 5 + adaptationLength > packet.length) return null;

  const flags = packet[5];
  if ((flags & 0x10) === 0) return null;

  const base =
    (BigInt(packet[6]) << 25n) |
    (BigInt(packet[7]) << 17n) |
    (BigInt(packet[8]) << 9n) |
    (BigInt(packet[9]) << 1n) |
    (BigInt(packet[10]) >> 7n);

  return {
    pid: ((packet[1] & 0x1f) << 8) | packet[2],
    ticks: Number(base),
    discontinuity: Boolean(flags & 0x80),
  };
}

export function pcrDeltaMs(previousTicks, currentTicks) {
  if (!Number.isFinite(previousTicks) || !Number.isFinite(currentTicks)) return null;
  let delta = currentTicks - previousTicks;
  if (delta < 0) delta += PCR_WRAP_TICKS;
  return delta / 90;
}

export function nextPcrDueAt(previousTicks, previousDueAt, currentTicks) {
  const deltaMs = pcrDeltaMs(previousTicks, currentTicks);
  if (deltaMs == null || deltaMs < 0 || deltaMs > PCR_MAX_STEP_MS) return null;
  return previousDueAt + deltaMs;
}

function concatPackets(packets) {
  if (!packets.length) return Buffer.alloc(0);
  if (packets.length === 1) return packets[0];
  return Buffer.concat(packets, packets.length * TS_PACKET_SIZE);
}

/**
 * A bounded, RAM-only delay line for ffmpeg MPEG-TS output.
 *
 * PCR timestamps pace output on the original media clock, so every packet is
 * kept roughly `delayMs` behind the upstream. That means a short upstream/CDN
 * fetch stall can consume the queued media while late packets catch up.
 * Streams without a usable PCR fall back to a simple wall-clock delay instead
 * of failing playback.
 */
export class RollingTsMediaBuffer {
  constructor({
    delayMs,
    maxBytes,
    write,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onModeChange = () => {},
    onOverflow = () => {},
  }) {
    this.delayMs = Math.max(0, Number(delayMs || 0));
    this.maxBytes = Math.max(1, Number(maxBytes || 1));
    this.write = write;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onModeChange = onModeChange;
    this.onOverflow = onOverflow;

    this.queue = [];
    this.queueBytes = 0;
    this.intervalPackets = [];
    this.intervalBytes = 0;
    this.residual = Buffer.alloc(0);
    this.firstDataAt = null;
    this.pcrPid = null;
    this.lastPcrTicks = null;
    this.lastPcrDueAt = null;
    this.lastQueuedDueAt = 0;
    this.mode = this.delayMs > 0 ? "pcr" : "off";
    this.timer = null;
    this.noPcrTimer = null;
    this.blocked = false;
    this.destroyed = false;
    this.overflowing = false;
  }

  get bufferedBytes() {
    return this.queueBytes + this.intervalBytes + this.residual.length;
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange(mode);
  }

  _clearTimer() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  _clearNoPcrTimer() {
    if (!this.noPcrTimer) return;
    this.clearTimer(this.noPcrTimer);
    this.noPcrTimer = null;
  }

  _armNoPcrFallback() {
    if (this.noPcrTimer || this.pcrPid != null || this.mode !== "pcr") return;
    this.noPcrTimer = this.setTimer(() => {
      this.noPcrTimer = null;
      if (this.destroyed || this.pcrPid != null || this.mode !== "pcr") return;
      this._fallbackToWallClock();
    }, PCR_STARTUP_GRACE_MS);
    this.noPcrTimer?.unref?.();
  }

  _schedule(data, dueAt) {
    if (!data?.length) return;
    const monotonicDueAt = Math.max(Number(dueAt || 0), this.lastQueuedDueAt);
    this.lastQueuedDueAt = monotonicDueAt;
    this.queue.push({ data, dueAt: monotonicDueAt });
    this.queueBytes += data.length;
  }

  _schedulePacketInterval(startDueAt, endDueAt) {
    if (!this.intervalPackets.length) return;

    const packets = this.intervalPackets;
    this.intervalPackets = [];
    this.intervalBytes = 0;
    const groups = Math.ceil(packets.length / TS_BATCH_PACKETS);
    const span = Math.max(0, endDueAt - startDueAt);

    for (let group = 0; group < groups; group += 1) {
      const begin = group * TS_BATCH_PACKETS;
      const end = Math.min(packets.length, begin + TS_BATCH_PACKETS);
      const fraction = (group + 1) / groups;
      const dueAt = startDueAt + span * fraction;
      this._schedule(concatPackets(packets.slice(begin, end)), dueAt);
    }
  }

  _fallbackToWallClock() {
    const now = this.now();
    const dueAt = Math.max(now, (this.firstDataAt ?? now) + this.delayMs);
    const pending = concatPackets(this.intervalPackets);
    this.intervalPackets = [];
    this.intervalBytes = 0;
    if (this.residual.length) {
      this._schedule(this.residual, dueAt);
      this.residual = Buffer.alloc(0);
    }
    this._schedule(pending, dueAt);
    this.pcrPid = null;
    this.lastPcrTicks = null;
    this.lastPcrDueAt = null;
    this._setMode("wall");
    this._pump();
  }

  _onPcr(pcr, receivedAt) {
    if (this.pcrPid == null) {
      this.pcrPid = pcr.pid;
      this.lastPcrTicks = pcr.ticks;
      this.lastPcrDueAt = Math.max(this.lastQueuedDueAt, receivedAt + this.delayMs);
      this._clearNoPcrTimer();
      this._schedulePacketInterval(this.lastPcrDueAt, this.lastPcrDueAt);
      return;
    }
    if (pcr.pid !== this.pcrPid) return;

    const nextDueAt = pcr.discontinuity
      ? null
      : nextPcrDueAt(this.lastPcrTicks, this.lastPcrDueAt, pcr.ticks);

    if (nextDueAt == null) {
      const rebasedDueAt = Math.max(this.lastQueuedDueAt, receivedAt + this.delayMs);
      this._schedulePacketInterval(rebasedDueAt, rebasedDueAt);
      this.lastPcrTicks = pcr.ticks;
      this.lastPcrDueAt = rebasedDueAt;
      return;
    }

    this._schedulePacketInterval(this.lastPcrDueAt, nextDueAt);
    this.lastPcrTicks = pcr.ticks;
    this.lastPcrDueAt = nextDueAt;
  }

  _alignData(data, receivedAt) {
    let offset = 0;
    while (offset < data.length && data[offset] !== 0x47) offset += 1;
    if (offset > 0) {
      this._schedule(data.subarray(0, offset), receivedAt + this.delayMs);
    }
    return offset;
  }

  /**
   * Start a fresh MPEG-TS producer without throwing away media already queued
   * for Jellyfin. Full packets from the old producer are committed to the tail
   * of the queue; an incomplete trailing packet is discarded so bytes from two
   * different FFmpeg processes can never be spliced into one corrupt TS packet.
   * PCR/PID discovery then starts again for the new producer and its first PCR
   * is scheduled no earlier than the existing queue tail.
   */
  beginSourceTransition() {
    if (this.destroyed || this.mode === "off") return;
    this._clearNoPcrTimer();

    if (this.intervalPackets.length) {
      const tailDueAt = Math.max(this.now(), this.lastQueuedDueAt);
      this._schedule(concatPackets(this.intervalPackets), tailDueAt);
      this.intervalPackets = [];
      this.intervalBytes = 0;
    }

    this.residual = Buffer.alloc(0);
    this.firstDataAt = null;
    this.pcrPid = null;
    this.lastPcrTicks = null;
    this.lastPcrDueAt = null;
    this._setMode("pcr");
    this._pump();
  }

  push(chunk) {
    if (this.destroyed || !chunk?.length) {
      return { bufferedBytes: this.bufferedBytes, backpressured: this.blocked, overflow: false };
    }

    const dataChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.mode === "off") {
      const ok = this.write(dataChunk);
      this.blocked = ok === false;
      return { bufferedBytes: 0, backpressured: this.blocked, overflow: false };
    }

    const receivedAt = this.now();
    if (this.firstDataAt == null) this.firstDataAt = receivedAt;

    if (this.mode === "wall") {
      this._schedule(dataChunk, receivedAt + this.delayMs);
      const overflow = this._handleOverflow();
      this._pump();
      return { bufferedBytes: this.bufferedBytes, backpressured: this.blocked, overflow };
    }

    this._armNoPcrFallback();
    let data = this.residual.length
      ? Buffer.concat([this.residual, dataChunk], this.residual.length + dataChunk.length)
      : dataChunk;
    this.residual = Buffer.alloc(0);

    let offset = this._alignData(data, receivedAt);
    while (offset + TS_PACKET_SIZE <= data.length) {
      if (data[offset] !== 0x47) {
        const next = this._alignData(data.subarray(offset), receivedAt);
        offset += Math.max(1, next);
        continue;
      }
      const packet = Buffer.from(data.subarray(offset, offset + TS_PACKET_SIZE));
      this.intervalPackets.push(packet);
      this.intervalBytes += packet.length;
      const pcr = extractPcrFromPacket(packet);
      if (pcr) this._onPcr(pcr, receivedAt);
      offset += TS_PACKET_SIZE;
    }

    if (offset < data.length) this.residual = Buffer.from(data.subarray(offset));

    const overflow = this._handleOverflow();
    this._pump();
    return { bufferedBytes: this.bufferedBytes, backpressured: this.blocked, overflow };
  }

  _handleOverflow() {
    if (this.bufferedBytes < this.maxBytes || this.overflowing) return false;
    this.overflowing = true;
    const bytes = this.bufferedBytes;
    this.onOverflow(bytes);
    this.flushNow();
    this.overflowing = false;
    return true;
  }

  _armPumpTimer() {
    this._clearTimer();
    const next = this.queue[0];
    if (!next || this.blocked || this.destroyed) return;
    const wait = Math.max(0, next.dueAt - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this._pump();
    }, wait);
    this.timer?.unref?.();
  }

  _pump() {
    if (this.blocked || this.destroyed) return;
    this._clearTimer();
    let now = this.now();
    while (this.queue.length && this.queue[0].dueAt <= now) {
      const item = this.queue.shift();
      this.queueBytes -= item.data.length;
      const ok = this.write(item.data);
      if (ok === false) {
        this.blocked = true;
        return;
      }
      now = this.now();
    }
    this._armPumpTimer();
  }

  drain() {
    if (this.destroyed) return;
    this.blocked = false;
    this._pump();
  }

  flushNow() {
    if (this.destroyed) return;
    this._clearNoPcrTimer();
    const now = this.now();
    if (this.intervalPackets.length) {
      this._schedule(concatPackets(this.intervalPackets), now);
      this.intervalPackets = [];
      this.intervalBytes = 0;
    }
    if (this.residual.length) {
      this._schedule(this.residual, now);
      this.residual = Buffer.alloc(0);
    }
    for (const item of this.queue) item.dueAt = now;
    this.lastQueuedDueAt = now;
    this._pump();
  }

  clear() {
    this.destroyed = true;
    this._clearTimer();
    this._clearNoPcrTimer();
    this.queue = [];
    this.queueBytes = 0;
    this.intervalPackets = [];
    this.intervalBytes = 0;
    this.residual = Buffer.alloc(0);
  }
}
