import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImageCache, normalizeRemoteImageUrl } from "../src/cache.js";
import { rewriteM3uImages, rewriteXmlTvImages } from "../src/rewrite.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function tempCache(fetchImpl, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-image-cache-"));
  const cache = new ImageCache({
    cacheDir: dir,
    ttlMs: 60_000,
    negativeTtlMs: 60_000,
    fetchTimeoutMs: 5_000,
    fetchConcurrency: 2,
    maxBytes: 1024 * 1024,
    missWaitMs: 250,
    hostBackoffMs: 60_000,
    fetchImpl,
    ...overrides,
  });
  return { cache, dir };
}

test("repairs the malformed concatenated Telerama URL seen during guide refresh", () => {
  assert.equal(
    normalizeRemoteImageUrl("https://television.telerama.frhttps://focus.telerama.fr/0000/00/01/clear-192.png"),
    "https://focus.telerama.fr/0000/00/01/clear-192.png",
  );
});

test("keeps legitimate nested URLs in query strings intact", () => {
  const value = "https://images.example/proxy?url=https://cdn.example/logo.png";
  assert.equal(normalizeRemoteImageUrl(value), value);
});

test("rejects literal private-network image targets", () => {
  assert.equal(normalizeRemoteImageUrl("http://127.0.0.1/logo.png"), "");
  assert.equal(normalizeRemoteImageUrl("http://192.168.1.20/logo.png"), "");
  assert.equal(normalizeRemoteImageUrl("http://[::1]/logo.png"), "");
});

test("M3U logos are rewritten to stable local cache URLs without changing playback", async () => {
  const { cache, dir } = await tempCache();
  try {
    const input = '#EXTM3U\n#EXTINF:-1 tvg-id="one" tvg-logo="https://upload.wikimedia.org/logo.png",One\nhttps://resolver.example/play/live/1.ts?token=abc\n';
    const out = rewriteM3uImages(input, cache, {
      publicUrl: "http://resolver:8080",
      playlistKey: "secret",
    });
    assert.doesNotMatch(out, /upload\.wikimedia\.org/);
    assert.match(out, /tvg-logo="http:\/\/resolver:8080\/jellyfin\/image\/[a-f0-9]{64}\?key=secret"/);
    assert.match(out, /https:\/\/resolver\.example\/play\/live\/1\.ts\?token=abc/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("XMLTV channel and programme artwork is rewritten through the same cache", async () => {
  const { cache, dir } = await tempCache();
  try {
    const input = '<?xml version="1.0"?><tv><channel id="one"><icon src="https://logos.example/one.png" /></channel><programme channel="one"><icon src="https://images.example/show.jpg" /><image type="backdrop">https://images.example/wide.jpg</image></programme></tv>';
    const out = rewriteXmlTvImages(input, cache, {
      publicUrl: "http://resolver:8080",
      playlistKey: "secret",
    });
    assert.doesNotMatch(out, /logos\.example|images\.example/);
    assert.equal((out.match(/\/jellyfin\/image\//g) || []).length, 3);
    assert.match(out, /\?key=secret/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("generated JustOne artwork is never recursively rewritten", async () => {
  const { cache, dir } = await tempCache();
  try {
    const local = "http://resolver:8080/jellyfin/artwork/channel/abc.png?key=secret";
    const out = rewriteM3uImages(`#EXTINF:-1 tvg-logo="${local}",One\nhttp://stream\n`, cache, {
      publicUrl: "http://resolver:8080",
      playlistKey: "secret",
    });
    assert.match(out, /\/jellyfin\/artwork\/channel\/abc\.png/);
    assert.doesNotMatch(out, /\/jellyfin\/image\//);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("successful remote image is fetched once then served from disk cache", async () => {
  let calls = 0;
  const { cache, dir } = await tempCache(async () => {
    calls += 1;
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  });
  try {
    const { token } = cache.register("https://cdn.example/logo.png");
    const first = await cache.get(token, 1_000_000);
    const second = await cache.get(token, 1_001_000);
    assert.equal(first.state, "miss");
    assert.equal(second.state, "hit");
    assert.equal(first.contentType, "image/png");
    assert.equal(calls, 1);
    assert.deepEqual(second.body, PNG);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("slow first image fetch does not block Jellyfin guide refresh", async () => {
  let calls = 0;
  const { cache, dir } = await tempCache(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  }, { missWaitMs: 10 });
  try {
    const { token } = cache.register("https://slow.example/logo.png");
    const started = Date.now();
    const first = await cache.get(token);
    const elapsed = Date.now() - started;
    assert.equal(first.state, "fallback");
    assert.equal(first.reason, "warming");
    assert.ok(elapsed < 70, `first request blocked for ${elapsed}ms`);
    assert.equal(calls, 1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await cache.get(token);
    assert.equal(second.state, "hit");
    assert.deepEqual(second.body, PNG);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("429 is negatively cached and returns HTTP-safe placeholder bytes instead of retrying", async () => {
  let calls = 0;
  const { cache, dir } = await tempCache(async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } });
  });
  try {
    const { token } = cache.register("https://upload.wikimedia.org/rate-limited.png");
    const first = await cache.get(token, 2_000_000);
    const second = await cache.get(token, 2_001_000);
    assert.equal(first.state, "fallback");
    assert.equal(second.state, "fallback");
    assert.equal(first.contentType, "image/png");
    assert.ok(first.body.length > 20);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("one 429 backs off the whole image host instead of hammering every logo URL", async () => {
  let calls = 0;
  const { cache, dir } = await tempCache(async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } });
  });
  try {
    const firstToken = cache.register("https://upload.wikimedia.org/one.png").token;
    const secondToken = cache.register("https://upload.wikimedia.org/two.png").token;
    const first = await cache.get(firstToken, 3_000_000);
    const second = await cache.get(secondToken, 3_001_000);
    assert.equal(first.state, "fallback");
    assert.equal(second.state, "fallback");
    assert.equal(calls, 1);
    assert.equal(cache.snapshot(3_001_000).hostCooldowns, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
