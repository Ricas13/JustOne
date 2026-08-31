import test from "node:test";
import assert from "node:assert/strict";
import {
  hlsProxySuffixForTarget,
  hlsTokenForTarget,
  hlsTokenFromProxyPath,
  rewriteHlsManifest,
} from "../src/play.js";

test("HLS manifest rewrites relative variants, segments, keys and maps through the proxy", () => {
  const manifest = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/key.bin\"",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160",
    "variants/2160/index.m3u8",
    "#EXTINF:4.0,",
    "segments/0001.m4s",
    "",
  ].join("\n");

  const seen = [];
  const output = rewriteHlsManifest(
    manifest,
    "https://cdn.example/path/master.m3u8?token=abc",
    (url, hls) => {
      seen.push({ url, hls });
      return `https://resolver.example/play/hls/${seen.length}`;
    },
  );

  assert.match(output, /URI="https:\/\/resolver\.example\/play\/hls\/1"/);
  assert.match(output, /URI="https:\/\/resolver\.example\/play\/hls\/2"/);
  assert.match(output, /https:\/\/resolver\.example\/play\/hls\/3/);
  assert.match(output, /https:\/\/resolver\.example\/play\/hls\/4/);

  assert.deepEqual(seen, [
    { url: "https://cdn.example/keys/key.bin", hls: false },
    { url: "https://cdn.example/path/init.mp4", hls: false },
    { url: "https://cdn.example/path/variants/2160/index.m3u8", hls: true },
    { url: "https://cdn.example/path/segments/0001.m4s", hls: false },
  ]);
});

test("HLS manifest leaves non-http key schemes untouched", () => {
  const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license.example/key"\n';
  const output = rewriteHlsManifest(manifest, "https://cdn.example/master.m3u8", () => {
    throw new Error("mapper should not be called");
  });
  assert.equal(output, manifest);
});

test("same HLS resource keeps the same proxy identity across manifest refreshes", () => {
  const url = "https://cdn.example/live/segment-184.ts?sig=abc";
  const a = hlsTokenForTarget(url, { Referer: "https://player.example/", Origin: "https://player.example" });
  const b = hlsTokenForTarget(url, { origin: "https://player.example", referer: "https://player.example/" });

  assert.equal(a, b, "header object order/casing must not create a new segment identity");
  assert.notEqual(a, hlsTokenForTarget("https://cdn.example/live/segment-185.ts?sig=abc", {
    referer: "https://player.example/",
    origin: "https://player.example",
  }));
  assert.notEqual(a, hlsTokenForTarget(url, {
    referer: "https://other-player.example/",
    origin: "https://player.example",
  }));
});

test("two refreshes rewrite the same segment to the same local token", () => {
  const manifest = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:184\n#EXTINF:6,\nsegment-184.ts\n";
  const rewrite = () => rewriteHlsManifest(
    manifest,
    "https://cdn.example/live/index.m3u8",
    (url, hls) => `https://resolver.example/play/hls/${hlsTokenForTarget(url, {}, hls)}`,
  );

  assert.equal(rewrite(), rewrite());
});

test("HLS proxy URLs retain ffmpeg-safe visible extensions without changing token identity", () => {
  assert.equal(hlsProxySuffixForTarget("https://cdn.example/live/master", true), ".m3u8");
  assert.equal(hlsProxySuffixForTarget("https://cdn.example/live/seg-1.ts?sig=x", false), ".ts");
  assert.equal(hlsProxySuffixForTarget("https://cdn.example/live/init.m4s", false), ".m4s");
  assert.equal(
    hlsProxySuffixForTarget("http://dlhd-proxy:3000/hls/encrypted-token", false),
    ".ts",
    "DLHD hides segment filenames behind an encrypted extensionless route",
  );

  const token = hlsTokenForTarget("http://dlhd-proxy:3000/hls/encrypted-token", {}, false);
  assert.equal(hlsTokenFromProxyPath(`${token}.ts`), token);
  assert.equal(hlsTokenFromProxyPath(`${token}.m3u8`), token);
});
