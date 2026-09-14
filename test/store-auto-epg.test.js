import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

test("auto XMLTV is deduplicated per provider and can be disabled provider-wide", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-epg-"));
  process.env.DATA_DIR = dir;
  const store = await import(`../src/store.js?auto-epg=${Date.now()}`);

  const state = {
    version: 1,
    sources: [
      {
        id: "a1",
        name: "Provider - Line 1",
        provider: "Provider",
        account: "Line 1",
        url: "http://iptv.example/get.php?username=a1&password=p1&type=m3u_plus",
        enabled: true,
      },
      {
        id: "a2",
        name: "Provider - Line 2",
        provider: "Provider",
        account: "Line 2",
        url: "http://iptv.example/get.php?username=a2&password=p2&type=m3u_plus",
        enabled: true,
      },
    ],
    guides: [],
    aliases: {},
    overrides: {},
  };

  await store.saveState(state);
  const loaded = await store.loadState();
  const auto = loaded.guides.filter((guide) => guide.auto === true);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].sourceId, "a1");
  assert.match(auto[0].url, /xmltv\.php\?username=a1&password=p1/);

  loaded.sources[0].epgDisabled = true;
  loaded.guides = loaded.guides.filter((guide) => guide.auto !== true);
  await store.saveState(loaded);

  const disabled = await store.loadState();
  assert.equal(disabled.guides.filter((guide) => guide.auto === true).length, 0);
  assert.equal(disabled.sources.every((source) => source.epgDisabled === true), true);

  await fs.rm(dir, { recursive: true, force: true });
});
