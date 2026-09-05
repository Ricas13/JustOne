import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

process.env.PUBLIC_URL = "https://resolver.example";
process.env.PLAYBACK_URL = "https://resolver.example";
process.env.PLAYLIST_KEY = "test-key";
process.env.STREAM_SIGNING_SECRET = "stream-signing-test-secret";
process.env.STREAM_TOKEN_TTL_SECONDS = "3600";

const { config } = await import("../src/config.js");
const { buildM3u } = await import("../src/generate.js");

test("Jellyfin playback origin can be public HTTPS", () => {
  assert.equal(config.publicUrl, "https://resolver.example");
  assert.equal(config.playbackUrl, "https://resolver.example");
});

test("generated Jellyfin live URLs are signed and never expose the playlist key", () => {
  const m3u = buildM3u([
    { id: "49", name: "Example TV", group: "UK", kind: "247" },
  ]);
  assert.match(m3u, /https:\/\/resolver\.example\/play\/live\/49\.ts\?exp=\d+&sig=[a-f0-9]{64}/);
  assert.doesNotMatch(m3u, /key=test-key/);
});

test("MPEG-TS playback starts the supervisor before resolving the HLS source", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf('app.get("/play/live/:channelId"');
  const end = source.indexOf('app.get("/play/ext/:id"', start);
  assert.ok(start >= 0 && end > start, "play/live route must exist");

  const route = source.slice(start, end);
  const tsBranch = route.indexOf("if (asTs)");
  const restream = route.indexOf("await restreamMpegTs", tsBranch);
  const resolve = route.indexOf("const picked = await resolveLive", tsBranch);

  assert.ok(tsBranch >= 0, "TS branch must exist");
  assert.ok(restream > tsBranch, "TS branch must enter the persistent FFmpeg supervisor");
  assert.ok(resolve > restream, "source resolution must be owned by the loopback HLS route, not pre-run for TS");
  assert.match(route.slice(tsBranch, resolve), /127\.0\.0\.1:\$\{config\.port\}\/play\/live\/\$\{id\}\.m3u8/);
});
