import test from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_URL = "https://resolver.example";
process.env.PLAYBACK_URL = "http://resolver:8080";
process.env.PLAYLIST_KEY = "test-key";

const { config } = await import("../src/config.js");
const { buildM3u } = await import("../src/generate.js");

test("public and playback origins remain separate", () => {
  assert.equal(config.publicUrl, "https://resolver.example");
  assert.equal(config.playbackUrl, "http://resolver:8080");
});

test("generated Jellyfin playback URLs use the internal resolver alias", () => {
  const m3u = buildM3u([
    { id: "49", name: "Example TV", group: "UK", kind: "247" },
  ]);
  assert.match(m3u, /http:\/\/resolver:8080\/play\/live\/49\.ts\?key=test-key/);
  assert.doesNotMatch(m3u, /https:\/\/resolver\.example\/play\/live\//);
});
