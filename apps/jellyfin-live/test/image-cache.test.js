import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-image-cache-"));
process.env.PUBLIC_URL = "https://resolver.example";
process.env.PLAYLIST_KEY = "image-cache-test-key";
process.env.JELLYFIN_IMAGE_CACHE_DIR = cacheDir;
process.env.JELLYFIN_IMAGE_CACHE_TTL_MS = "60000";
process.env.JELLYFIN_IMAGE_CACHE_NEGATIVE_TTL_MS = "60000";
process.env.JELLYFIN_IMAGE_CACHE_FETCH_CONCURRENCY = "2";
process.env.JELLYFIN_IMAGE_CACHE_MAX_BYTES = "1048576";

const {
  cachedImageUrl,
  getCachedImage,
  localizeLineupImages,
  localizeXmlTvImages,
  normalizeRemoteImageUrl,
  resetImageCacheForTests,
} = await import("../src/image-cache.js");

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function tokenFrom(url) {
  return new URL(url).pathname.split("/").at(-1);
}

test.after(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

test("repairs concatenated absolute EPG image URLs", () => {
  const broken = "https://television.telerama.frhttps://focus.telerama.fr/0000/00/01/clear-192.png";
  assert.equal(
    normalizeRemoteImageUrl(broken),
    "https://focus.telerama.fr/0000/00/01/clear-192.png",
  );
});

test("does not mistake a legitimate URL in a query string for concatenation", () => {
  const nested = "https://images.example/proxy?url=https://cdn.example/logo.png";
  assert.equal(normalizeRemoteImageUrl(nested), nested);
});

test("remote logo becomes a stable JustOne URL and preserves no upstream hostname", () => {
  resetImageCacheForTests();
  const a = cachedImageUrl("https://upload.wikimedia.org/logo.png", { variant: "channel", channelId: "abc" });
  const b = cachedImageUrl("https://upload.wikimedia.org/logo.png", { variant: "channel", channelId: "abc" });
  assert.equal(a, b);
  assert.match(a, /^https:\/\/resolver\.example\/jellyfin\/image\/[a-f0-9]{64}\?/);
  assert.doesNotMatch(a, /wikimedia\.org/);
  assert.match(a, /key=image-cache-test-key/);
});

test("same remote image is downloaded only once and then served from disk cache", async () => {
  resetImageCacheForTests();
  const local = cachedImageUrl("https://cdn.example/logo.png", { variant: "channel", channelId: "one" });
  const token = tokenFrom(local);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  };

  const first = await getCachedImage(token, { fetchImpl, now: 1_000_000 });
  const second = await getCachedImage(token, { fetchImpl, now: 1_001_000 });
  assert.equal(first.state, "miss");
  assert.equal(second.state, "hit");
  assert.equal(first.contentType, "image/png");
  assert.equal(calls, 1);
  assert.deepEqual(second.body, PNG);
});

test("429 failures are negatively cached instead of repeatedly hammering the host", async () => {
  resetImageCacheForTests();
  const local = cachedImageUrl("https://upload.wikimedia.org/rate-limited.png", { variant: "channel", channelId: "two" });
  const token = tokenFrom(local);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } });
  };

  await assert.rejects(() => getCachedImage(token, { fetchImpl, now: 2_000_000 }), /429/);
  await assert.rejects(() => getCachedImage(token, { fetchImpl, now: 2_001_000 }), /429|temporarily unavailable/);
  assert.equal(calls, 1);
});

test("lineup and XMLTV images are rewritten to local cache URLs", () => {
  resetImageCacheForTests();
  const lineup = [{
    id: "channel.one",
    tvgId: "guide.one",
    logo: "https://logos.example/channel.png",
  }];
  localizeLineupImages(lineup);
  assert.match(lineup[0].logo, /resolver\.example\/jellyfin\/image\//);

  const xml = `<?xml version="1.0"?><tv>
  <channel id="guide.one"><display-name>One</display-name><icon src="https://logos.example/channel.png" /></channel>
  <programme start="20260911120000 +0000" stop="20260911130000 +0000" channel="guide.one"><title>Show</title><icon src="https://images.example/show.jpg" /><image type="backdrop">https://images.example/show-wide.jpg</image></programme>
</tv>`;
  const localized = localizeXmlTvImages(xml, lineup);
  assert.doesNotMatch(localized, /logos\.example|images\.example/);
  assert.ok((localized.match(/\/jellyfin\/image\//g) || []).length >= 3);
});
