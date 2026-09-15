import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createXmltvCachingFetch, isXmltvUrl } from "../src/upstream-xmltv-cache.js";

test("XMLTV URL detection is limited to guide-like URLs", () => {
  assert.equal(isXmltvUrl("https://example.test/xmltv.php?username=a&password=b"), true);
  assert.equal(isXmltvUrl("https://example.test/guide.xml"), true);
  assert.equal(isXmltvUrl("https://example.test/get.php?username=a&password=b&type=m3u_plus"), false);
});

test("real upstream XMLTV is cached and reused on a temporary 504", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-xmltv-"));
  process.env.DATA_DIR = dir;
  const url = "https://provider.test/xmltv.php?username=user&password=pass";
  const xml = '<?xml version="1.0"?><tv><channel id="bbc1"><display-name>BBC One</display-name></channel></tv>';
  let calls = 0;
  const warnings = [];
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    return new Response("gateway timeout", { status: 504, statusText: "Gateway Time-out" });
  };
  const cachedFetch = createXmltvCachingFetch(fakeFetch, {
    maxAgeMinutes: 60,
    logger: { warn: (value) => warnings.push(String(value)) },
  });

  try {
    const first = await cachedFetch(url);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), xml);

    const second = await cachedFetch(url);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-justone-upstream-cache"), "1");
    assert.equal(await second.text(), xml);
    assert.equal(calls, 2);
    assert.match(warnings.join("\n"), /returned HTTP 504; using cached real upstream XMLTV/i);
  } finally {
    if (oldDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
