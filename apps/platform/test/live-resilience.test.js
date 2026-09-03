import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.LIVE_BUFFER_SECONDS = "0";
process.env.LIVE_FFMPEG_RESTART_DELAY_MS = "100";
process.env.LIVE_FFMPEG_MAX_RESTARTS_PER_SOURCE = "0";
process.env.LIVE_FAILOVER_MAX_SWITCHES = "2";

const {
  liveFfmpegArgs,
  liveFailoverInputUrls,
  restreamMpegTs,
} = await import("../src/play.js?live-resilience-test=1");

test("FFmpeg live argv reconnects and marks fresh TS output as discontinuous", () => {
  const args = liveFfmpegArgs("http://127.0.0.1/live.m3u8");
  const expectPair = (flag, value) => {
    const index = args.indexOf(flag);
    assert.ok(index >= 0, `${flag} is present`);
    assert.equal(args[index + 1], value);
  };
  expectPair("-reconnect", "1");
  expectPair("-reconnect_at_eof", "1");
  expectPair("-reconnect_streamed", "1");
  expectPair("-reconnect_on_network_error", "1");
  expectPair("-reconnect_on_http_error", "4xx,5xx");
  expectPair("-mpegts_flags", "+resend_headers+initial_discontinuity");
  assert.ok(args.includes("-rw_timeout"));
});

test("event fallback ids become bounded loopback-only HLS inputs", () => {
  const urls = liveFailoverInputUrls(
    { query: { failover: "402,403,402,https://evil.example/x" } },
    "http://127.0.0.1:8080/play/live/401.m3u8",
  );
  assert.deepEqual(urls, [
    "http://127.0.0.1:8080/play/live/401.m3u8",
    "http://127.0.0.1:8080/play/live/402.m3u8",
    "http://127.0.0.1:8080/play/live/403.m3u8",
  ]);
  assert.equal(urls.some((url) => url.includes("evil.example")), false);
});

test("FFmpeg death switches event source without ending Jellyfin response", async () => {
  const req = new EventEmitter();
  req.query = { failover: "402" };

  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.endCalls = 0;
  res.headers = new Map();
  res.setHeader = (name, value) => res.headers.set(name, value);
  res.write = () => {
    res.headersSent = true;
    return true;
  };
  res.status = () => res;
  res.end = () => {
    res.endCalls += 1;
    res.writableEnded = true;
  };

  const spawnedInputs = [];
  const children = [];
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    children.push(child);
    spawnedInputs.push(args[args.indexOf("-i") + 1]);

    queueMicrotask(() => {
      child.stdout.write(Buffer.from([0x47, 0x40, 0x00, 0x10]));
      if (children.length === 1) {
        setTimeout(() => child.emit("close", 1, null), 5);
      }
    });
    return child;
  };

  const running = restreamMpegTs(
    req,
    res,
    "http://127.0.0.1:8080/play/live/401.m3u8",
    { spawnImpl },
  );

  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(spawnedInputs, [
    "http://127.0.0.1:8080/play/live/401.m3u8",
    "http://127.0.0.1:8080/play/live/402.m3u8",
  ]);
  assert.equal(res.endCalls, 0, "the same Jellyfin HTTP response stays open during failover");
  assert.equal(res.headers.get("X-JustOne-Live-Failover-Sources"), "2");

  req.emit("aborted");
  await running;
});
