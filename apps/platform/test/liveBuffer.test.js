import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPcrFromPacket,
  liveBufferSettings,
  nextPcrDueAt,
  pcrDeltaMs,
  RollingTsMediaBuffer,
} from "../src/liveBuffer.js";

function pcrPacket(ticks, { pid = 256, discontinuity = false } = {}) {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x20;
  packet[4] = 7;
  packet[5] = 0x10 | (discontinuity ? 0x80 : 0);
  const base = BigInt(ticks);
  packet[6] = Number((base >> 25n) & 0xffn);
  packet[7] = Number((base >> 17n) & 0xffn);
  packet[8] = Number((base >> 9n) & 0xffn);
  packet[9] = Number((base >> 1n) & 0xffn);
  packet[10] = Number((base & 1n) << 7n) | 0x7e;
  packet[11] = 0;
  return packet;
}

test("live buffer defaults to two seconds and a 64 MiB cap", () => {
  const settings = liveBufferSettings({});
  assert.equal(settings.seconds, 2);
  assert.equal(settings.delayMs, 2000);
  assert.equal(settings.maxBytes, 64 * 1024 * 1024);
});

test("live buffer can be disabled and clamps excessive delay", () => {
  assert.equal(liveBufferSettings({ LIVE_BUFFER_SECONDS: "0" }).delayMs, 0);
  assert.equal(liveBufferSettings({ LIVE_BUFFER_SECONDS: "999" }).seconds, 30);
});

test("PCR parser reads the 90 kHz clock and discontinuity flag", () => {
  const packet = pcrPacket(123456789, { pid: 513, discontinuity: true });
  assert.deepEqual(extractPcrFromPacket(packet), {
    pid: 513,
    ticks: 123456789,
    discontinuity: true,
  });
});

test("PCR timeline survives wraparound and preserves media pacing", () => {
  const wrap = 2 ** 33;
  assert.ok(Math.abs(pcrDeltaMs(wrap - 90, 90) - 2) < 1e-9);
  assert.equal(nextPcrDueAt(0, 2000, 90000), 3000);
  assert.equal(nextPcrDueAt(90000, 3000, 180000), 4000);
});

test("rolling PCR buffer keeps a delayed media clock during an upstream stall", () => {
  let now = 0;
  const writes = [];
  const timers = [];
  const buffer = new RollingTsMediaBuffer({
    delayMs: 2000,
    maxBytes: 1024 * 1024,
    write(data) {
      writes.push({ at: now, bytes: data.length });
      return true;
    },
    now: () => now,
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  const runUntil = (target) => {
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const timer = timers[0];
      if (!timer || timer.at > target) break;
      timers.shift();
      now = timer.at;
      timer.fn();
    }
    now = target;
  };

  buffer.push(pcrPacket(0));
  runUntil(1000);
  buffer.push(pcrPacket(90000));

  // The next second of media is 1.5s late, but its delivery deadline stays on
  // the PCR media clock rather than being reset from the late arrival time.
  runUntil(3500);
  buffer.push(pcrPacket(180000));

  runUntil(4500);
  assert.deepEqual(writes.map((entry) => entry.at), [2000, 3000, 4000]);
  buffer.clear();
});

test("rolling buffer falls back to wall-clock delay if MPEG-TS has no PCR", () => {
  let now = 0;
  const writes = [];
  const timers = [];
  const buffer = new RollingTsMediaBuffer({
    delayMs: 2000,
    maxBytes: 1024 * 1024,
    write(data) {
      writes.push({ at: now, text: data.toString("utf8") });
      return true;
    },
    now: () => now,
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  buffer.push(Buffer.from("not transport stream"));
  timers.sort((a, b) => a.at - b.at);
  now = timers[0].at;
  timers.shift().fn();
  assert.equal(buffer.mode, "wall");

  while (timers.length) {
    timers.sort((a, b) => a.at - b.at);
    const timer = timers.shift();
    now = timer.at;
    timer.fn();
  }
  assert.equal(now, 2000);
  assert.equal(writes.length, 1);
  buffer.clear();
});
