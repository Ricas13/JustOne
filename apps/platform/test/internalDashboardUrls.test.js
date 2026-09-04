import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const helper = fs.readFileSync(new URL("../public/internal-endpoints.js", import.meta.url), "utf8");

test("dashboard rewrites recommended Jellyfin endpoints to playback origin", () => {
  assert.match(html, /src="\/internal-endpoints\.js"/);
  assert.match(helper, /firstPlaybackOrigin/);
  assert.match(helper, /\/jellyfin\/playlist\.m3u8/);
  assert.match(helper, /\/jellyfin\/guide\.xml/);
  assert.match(helper, /jf-m3u/);
  assert.match(helper, /jf-live/);
});
