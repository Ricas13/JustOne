import test from "node:test";
import assert from "node:assert/strict";
import {
  activeStreamStats,
  beginLiveStream,
  clearActiveStreams,
} from "../src/liveStreams.js";

test.beforeEach(() => clearActiveStreams());
test.afterEach(() => clearActiveStreams());

test("active stream telemetry counts viewer sessions and unique channels", () => {
  const first = beginLiveStream({ channelId: "49", provider: "amddeus-dlhd-proxy", now: 1_000 });
  const second = beginLiveStream({ channelId: "49", provider: "amddeus-dlhd-proxy", now: 2_000 });
  const third = beginLiveStream({ channelId: "580", provider: "legacy-dlhd-web", now: 3_000 });

  const stats = activeStreamStats(13_000);
  assert.equal(stats.active, 3);
  assert.equal(stats.uniqueChannels, 2);
  assert.deepEqual(stats.streams.map((row) => row.channelId), ["49", "49", "580"]);
  assert.deepEqual(stats.streams.map((row) => row.durationSeconds), [12, 11, 10]);

  assert.equal(second.end(), true);
  assert.equal(second.end(), false, "ending a stream is idempotent");
  assert.equal(activeStreamStats(13_000).active, 2);

  first.end();
  third.end();
  assert.equal(activeStreamStats(13_000).active, 0);
});

test("event-selector playback probes are excluded from viewer counts", () => {
  const probe = beginLiveStream({
    channelId: "49",
    provider: "amddeus-dlhd-proxy",
    userAgent: "Mozilla/5.0 JustOne Jellyfin Event Selector",
    now: 1_000,
  });

  assert.equal(probe.tracked, false);
  assert.equal(activeStreamStats(2_000).active, 0);
  assert.doesNotThrow(() => probe.end());
});

test("telemetry exposes no client IP or playlist credential data", () => {
  beginLiveStream({
    channelId: "49\r\nInjected",
    provider: "provider\nname",
    userAgent: "Jellyfin",
    now: 1_000,
  });
  const [row] = activeStreamStats(2_000).streams;

  assert.equal(row.channelId, "49  Injected");
  assert.equal(row.provider, "provider name");
  assert.deepEqual(Object.keys(row).sort(), [
    "channelId",
    "durationSeconds",
    "id",
    "provider",
    "startedAt",
  ]);
});
