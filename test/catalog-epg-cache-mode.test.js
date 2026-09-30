import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGuideDocs } from "../src/catalog.js";
import { loadCachedXmltv } from "../src/upstream-xmltv-cache.js";

function xml(title = "News") {
  return `<?xml version="1.0"?><tv>
    <channel id="bbc1"><display-name>BBC One</display-name></channel>
    <programme start="20260930090000 +0000" stop="20260930100000 +0000" channel="bbc1"><title>${title}</title></programme>
  </tv>`;
}

test("configured EPG URLs are cached and recovered even when the URL itself does not look like XMLTV", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const oldFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-configured-epg-"));
  process.env.DATA_DIR = dir;

  const guide = {
    id: "manual-1",
    name: "Provider Guide",
    url: "https://provider.test/custom.php?username=a&password=b",
    enabled: true,
    priority: 1,
  };
  const state = { guides: [guide] };
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(xml("Healthy"), {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response("<html>temporary login error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const first = await loadGuideDocs(state, "network");
    assert.equal(first.guideStatus[0].ok, true);
    assert.equal(first.guideStatus[0].cached, false);

    const disk = await loadCachedXmltv(guide.url, { allowStale: true });
    assert.ok(disk);
    assert.match(disk.body.toString("utf8"), /Healthy/);

    const second = await loadGuideDocs(state, "network");
    assert.equal(second.guideStatus[0].ok, true);
    assert.equal(second.guideStatus[0].cached, true);
    assert.match(second.guideStatus[0].recoveredFrom, /no channels/i);
    assert.equal(calls, 2);

    globalThis.fetch = async () => {
      throw new Error("cache-only refresh must not touch the network");
    };
    const cacheOnly = await loadGuideDocs(state, "cache");
    assert.equal(cacheOnly.guideStatus[0].ok, true);
    assert.equal(cacheOnly.guideStatus[0].cached, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
