import test from "node:test";
import assert from "node:assert/strict";
import { advertisedQuality } from "../src/services/qualityAvailability.js";

test("advertised quality recognises common 4K labels", () => {
  assert.equal(advertisedQuality({ quality: "2160p" }), "4k");
  assert.equal(advertisedQuality({ title: "Movie WEB-DL 4K" }), "4k");
  assert.equal(advertisedQuality({ name: "UHD source" }), "4k");
  assert.equal(advertisedQuality({ resolution: "3840x2160" }), "4k");
});

test("advertised quality keeps non-4K sources out of the 4K bucket", () => {
  assert.equal(advertisedQuality({ quality: "1080p" }), "1080p");
  assert.equal(advertisedQuality({ name: "720p source" }), "720p");
  assert.equal(advertisedQuality({ url: "https://example.test/video.m3u8" }), "unknown");
});
