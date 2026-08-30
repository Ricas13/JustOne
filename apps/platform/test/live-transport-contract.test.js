import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildM3u } from "../src/generate.js";

test("raw platform playlist keeps the original Grok live transport path", () => {
  const body = buildM3u([
    { id: "123", name: "Example TV", group: "UK", kind: "247" },
  ]);

  assert.match(body, /#EXTM3U/);
  assert.match(body, /\/play\/live\/123\.ts(?:\?|\r?\n)/);
  assert.doesNotMatch(body, /\/jellyfin\/play\//);
  assert.doesNotMatch(body, /\/jellyfin\/playlist\.m3u8/);
});

test("portal primary IPTV URL is the original platform live playlist", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /const M3U = `\$\{location\.origin\}\/live\/playlist\.m3u8`/);
  assert.match(source, /links\?\.all \|\| M3U/);
  assert.doesNotMatch(source, /keyedUrl\("\/jellyfin\/playlist\.m3u8"/);
});
