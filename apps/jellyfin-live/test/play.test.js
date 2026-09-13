import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeBridgeTarget,
  easyProxyManifestUrl,
  encodeBridgeTarget,
  resolveEasyProxyManifest,
  rewriteEasyProxyManifest,
} from "../src/easyproxy.js";

test("EasyProxy manifest URL carries the original provider page", () => {
  const source = "https://daddylive.sx/watch.php?id=123&foo=bar";
  const url = new URL(easyProxyManifestUrl(source));

  assert.equal(url.origin, "http://easyproxy:7860");
  assert.equal(url.pathname, "/proxy/manifest.m3u8");
  assert.equal(url.searchParams.get("url"), source);
});

test("bridge tokens are signed and cannot be tampered with", () => {
  const target = "http://easyproxy:7860/key?key_url=https%3A%2F%2Fexample.test%2Fkey.bin";
  const token = encodeBridgeTarget(target);

  assert.equal(decodeBridgeTarget(token).href, target);
  assert.throws(() => decodeBridgeTarget(`${token}x`), /signature|token/);
});

test("EasyProxy manifest URLs are rewritten through the authenticated JustOne bridge", () => {
  const body = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="http://easyproxy:7860/key?key_url=https%3A%2F%2Fkeys.test%2Fone"',
    "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fseg.ts",
    "",
  ].join("\n");

  const rewritten = rewriteEasyProxyManifest(body);
  assert.match(rewritten, /http:\/\/localhost:8090\/jellyfin\/proxy\//);
  assert.doesNotMatch(rewritten, /http:\/\/easyproxy:7860\/key/);
  assert.doesNotMatch(rewritten, /http:\/\/easyproxy:7860\/proxy/);
});

test("candidate fallback remains ordered but EasyProxy owns each media attempt", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    requested.push(parsed.searchParams.get("url"));
    if (requested.length === 1) {
      return new Response("extractor failed", { status: 502, headers: { "content-type": "text/plain" } });
    }
    return new Response(
      "#EXTM3U\nhttp://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fseg.ts\n",
      { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } },
    );
  };

  const result = await resolveEasyProxyManifest([
    { label: "first", url: "https://daddylive.sx/watch.php?id=10" },
    { label: "second", url: "https://daddylive.sx/watch.php?id=11" },
  ], { fetchImpl, timeoutMs: 5_000 });

  assert.deepEqual(requested, [
    "https://daddylive.sx/watch.php?id=10",
    "https://daddylive.sx/watch.php?id=11",
  ]);
  assert.equal(result.candidateIndex, 1);
  assert.match(result.body, /\/jellyfin\/proxy\//);
});
