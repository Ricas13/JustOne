import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { isPublicPath, isStreamPath } from "../src/auth.js";

test("resolver:8080 can front Jellyfin metadata routes", () => {
  assert.equal(config.jellyfinLiveUrl, "http://jellyfin-live:8090");
  assert.equal(isPublicPath("/jellyfin/playlist.m3u8"), true);
  assert.equal(isStreamPath("/jellyfin/playlist.m3u8"), true);
  assert.equal(isPublicPath("/jellyfin/guide.xml"), true);
  assert.equal(isStreamPath("/jellyfin/artwork/channel/example.png"), true);
});

test("Jellyfin health endpoints are public diagnostics, not protected stream paths", () => {
  assert.equal(isPublicPath("/jellyfin/health"), true);
  assert.equal(isStreamPath("/jellyfin/health"), false);
  assert.equal(isPublicPath("/jellyfin/image-cache/health"), true);
  assert.equal(isStreamPath("/jellyfin/image-cache/health"), false);
});
