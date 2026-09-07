import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.LIVE_BUFFER_SECONDS = "0";
process.env.LIVE_SHARED_REMUX = "true";
process.env.LIVE_SHARED_REMUX_IDLE_MS = "0";

const { restreamMpegTs, sharedLiveRemuxStats, clearSharedLiveRemuxes } = await import(
  "../src/play.js?shared-live-remux-test=1"
);

function fakeResponse() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.headers = new Map();
  res.chunks = [];
  res.setHeader = (name, value) => res.headers.set(name, value);
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.write = (chunk) => {
    res.headersSent = true;
    res.chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  return res;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test("viewers of the same channel share one FFmpeg producer", async () => {
  clearSharedLiveRemuxes();
  let spawnCount = 0;
  let child;
  const spawnImpl = () => {
    spawnCount += 1;
    child = fakeChild();
    queueMicrotask(() => child.stdout.write(Buffer.from([0x47, 0x40, 0x00, 0x10])));
    return child;
  };

  const reqA = new EventEmitter();
  reqA.query = {};
  const reqB = new EventEmitter();
  reqB.query = {};
  const resA = fakeResponse();
  const resB = fakeResponse();

  const runningA = restreamMpegTs(
    reqA,
    resA,
    "http://127.0.0.1:8080/play/live/494.m3u8",
    { spawnImpl },
  );
  const runningB = restreamMpegTs(
    reqB,
    resB,
    "http://127.0.0.1:8080/play/live/494.m3u8",
    { spawnImpl },
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawnCount, 1, "only one FFmpeg child is created for the channel");
  assert.equal(resA.headers.get("X-JustOne-Live-Shared-Remux"), "1");
  assert.equal(resB.headers.get("X-JustOne-Live-Shared-Remux"), "1");
  assert.ok(resA.chunks.length > 0, "first viewer receives producer bytes");
  assert.ok(resB.chunks.length > 0, "second viewer receives the same producer bytes");

  const stats = sharedLiveRemuxStats();
  assert.equal(stats.producers, 1);
  assert.equal(stats.subscribers, 2);

  reqA.emit("aborted");
  reqB.emit("aborted");
  await Promise.all([runningA, runningB]);
  assert.equal(child.killed, true, "last subscriber stops the producer when idle grace is zero");

  clearSharedLiveRemuxes();
});
