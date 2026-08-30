import assert from "node:assert/strict";
import test from "node:test";
import { buildM3u } from "../src/generate.js";
import { playLivePath } from "../src/play.js";

test("LiveTV defaults to HLS rather than the MPEG-TS restreamer", () => {
  assert.equal(playLivePath("123"), "/play/live/123.m3u8");
  assert.equal(playLivePath("123.ts"), "/play/live/123.m3u8");
  assert.equal(playLivePath("123.m3u8"), "/play/live/123.m3u8");
});

test("generated Jellyfin M3U points DLHD channels at the HLS route", () => {
  const body = buildM3u([
    { id: "123", name: "Example", group: "Live", kind: "247" },
  ]);

  assert.match(body, /\/play\/live\/123\.m3u8(?:\?|$)/);
  assert.doesNotMatch(body, /\/play\/live\/123\.ts(?:\?|$)/);
});
