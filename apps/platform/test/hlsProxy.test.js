import test from "node:test";
import assert from "node:assert/strict";
import { rewriteHlsManifest } from "../src/play.js";

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
  assert.equal(output, manifest.trimEnd());
});
