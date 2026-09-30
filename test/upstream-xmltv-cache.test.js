import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createXmltvCachingFetch,
  isXmltvUrl,
  loadCachedXmltv,
  looksLikeUsefulXmltv,
} from "../src/upstream-xmltv-cache.js";

function validXml(title = "News") {
  return `<?xml version="1.0"?><tv>
    <channel id="bbc1"><display-name>BBC One</display-name></channel>
    <programme start="20260930090000 +0000" stop="20260930100000 +0000" channel="bbc1"><title>${title}</title></programme>
  </tv>`;
}

test("XMLTV URL detection covers common guide endpoints but not provider M3U", () => {
  assert.equal(isXmltvUrl("https://example.test/xmltv.php?username=a&password=b"), true);
  assert.equal(isXmltvUrl("https://example.test/epg.php?username=a&password=b"), true);
  assert.equal(isXmltvUrl("https://example.test/get.php?username=a&password=b&type=xmltv"), true);
  assert.equal(isXmltvUrl("https://example.test/guide.xml"), true);
  assert.equal(isXmltvUrl("https://example.test/get.php?username=a&password=b&type=m3u_plus"), false);
});

test("useful XMLTV requires a TV root, channel metadata and programme data", () => {
  assert.equal(looksLikeUsefulXmltv(Buffer.from(validXml())), true);
  assert.equal(looksLikeUsefulXmltv(Buffer.from("<tv><channel id=\"x\"></channel></tv>")), false);
  assert.equal(looksLikeUsefulXmltv(Buffer.from("<html>login failed</html>")), false);
  assert.equal(looksLikeUsefulXmltv(Buffer.alloc(0)), false);
});

test("real upstream XMLTV is cached and reused on a temporary 504", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-xmltv-"));
  process.env.DATA_DIR = dir;
  const url = "https://provider.test/xmltv.php?username=user&password=pass";
  const xml = validXml();
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

test("HTTP 200 with HTML or empty provider output cannot replace a healthy XMLTV cache", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-xmltv-invalid-"));
  process.env.DATA_DIR = dir;
  const url = "https://provider.test/xmltv.php?username=user&password=pass";
  const xml = validXml("Healthy Guide");
  let calls = 0;
  const warnings = [];
  const cachedFetch = createXmltvCachingFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    return new Response("<html><body>account temporarily unavailable</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }, {
    maxAgeMinutes: 60,
    logger: { warn: (value) => warnings.push(String(value)) },
  });

  try {
    await cachedFetch(url);
    const fallback = await cachedFetch(url);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("x-justone-upstream-cache"), "1");
    assert.equal(await fallback.text(), xml);
    const disk = await loadCachedXmltv(url, { maxAgeMinutes: 60 });
    assert.equal(disk.body.toString("utf8"), xml);
    assert.match(warnings.join("\n"), /unusable body/i);
  } finally {
    if (oldDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an unusable HTTP 200 without a prior cache fails instead of publishing an empty guide", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-xmltv-empty-"));
  process.env.DATA_DIR = dir;
  const url = "https://provider.test/xmltv.php?username=user&password=pass";
  const cachedFetch = createXmltvCachingFetch(async () => new Response("", { status: 200 }));

  try {
    await assert.rejects(() => cachedFetch(url), /unusable body/i);
    assert.equal(await loadCachedXmltv(url, { allowStale: true }), null);
  } finally {
    if (oldDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("provider outages may use stale cached XMLTV rather than dropping EPG completely", async () => {
  const oldDataDir = process.env.DATA_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-xmltv-stale-"));
  process.env.DATA_DIR = dir;
  const url = "https://provider.test/xmltv.php?username=user&password=pass";
  const xml = validXml("Last Known Good");
  let calls = 0;
  const cachedFetch = createXmltvCachingFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    throw new Error("provider offline");
  }, { maxAgeMinutes: 1, logger: { warn() {} } });

  try {
    await cachedFetch(url);
    const cacheDir = path.join(dir, "upstream-xmltv-cache");
    const metaName = (await fs.readdir(cacheDir)).find((name) => name.endsWith(".json"));
    const metaPath = path.join(cacheDir, metaName);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.cachedAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(metaPath, JSON.stringify(meta));

    assert.equal(await loadCachedXmltv(url, { maxAgeMinutes: 1 }), null);
    const stale = await loadCachedXmltv(url, { maxAgeMinutes: 1, allowStale: true });
    assert.equal(stale.stale, true);

    const fallback = await cachedFetch(url);
    assert.equal(fallback.headers.get("x-justone-upstream-cache"), "1");
    assert.equal(fallback.headers.get("x-justone-upstream-cache-stale"), "1");
    assert.equal(await fallback.text(), xml);
  } finally {
    if (oldDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
