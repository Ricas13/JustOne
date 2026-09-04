import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("dashboard recommends Docker-internal Jellyfin endpoints", () => {
  assert.match(index, /playbackUrl:\s*config\.playbackUrl/);
  assert.match(app, /function keyedBaseUrl\(/);
  assert.match(app, /health\?\.playbackUrl/);
  assert.match(app, /keyedBaseUrl\(health\?\.playbackUrl, "\/jellyfin\/playlist\.m3u8", liveLinks\)/);
  assert.match(app, /keyedBaseUrl\(health\?\.playbackUrl, "\/jellyfin\/guide\.xml", liveLinks\)/);
});
