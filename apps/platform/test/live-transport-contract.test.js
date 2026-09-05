import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

process.env.STREAM_SIGNING_SECRET = "transport-contract-test-secret";

const { buildM3u } = await import("../src/generate.js");

test("raw platform playlist keeps the original Grok live transport path", () => {
  const body = buildM3u([
    { id: "123", name: "Example TV", group: "UK", kind: "247" },
  ]);

  assert.match(body, /#EXTM3U/);
  assert.match(body, /\/play\/live\/123\.ts(?:\?|\r?\n)/);
  assert.doesNotMatch(body, /\/jellyfin\/play\//);
  assert.doesNotMatch(body, /\/jellyfin\/playlist\.m3u8/);
});

test("portal keeps the original platform live playlist as the raw compatibility feed", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /RAW \/ COMPATIBILITY/);
  assert.match(source, /urlBox\("raw-all",\s*"Everything",\s*links\.all \|\| "",\s*"Raw feed"\)/);
  assert.match(source, /keyedUrl\("\/jellyfin\/playlist\.m3u8",\s*links\)/);
});
