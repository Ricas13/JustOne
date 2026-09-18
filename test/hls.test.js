import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { HlsMpegTsReader, isHlsResponse, parseHlsPlaylist } from "../src/hls.js";

function tsChunk(label, packets = 3) {
  const fill = Buffer.from(String(label || "X"))[0] || 0x58;
  const out = Buffer.alloc(188 * packets, fill);
  for (let packet = 0; packet < packets; packet += 1) out[packet * 188] = 0x47;
  return out;
}

test("HLS parser resolves master variants, media segments and byte ranges", () => {
  const master = parseHlsPlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
high/index.m3u8
`, "https://provider.example/master.m3u8");
  assert.equal(master.master, true);
  assert.equal(master.variants[1].url, "https://provider.example/high/index.m3u8");

  const media = parseHlsPlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXTINF:6,
seg42.ts
#EXT-X-BYTERANGE:1000@200
#EXTINF:6,
shared.ts
`, "https://provider.example/live/index.m3u8");
  assert.equal(media.master, false);
  assert.deepEqual(media.segments.map((s) => s.sequence), [42, 43]);
  assert.equal(media.segments[0].url, "https://provider.example/live/seg42.ts");
  assert.deepEqual(media.segments[1].byteRange, { length: 1000, offset: 200 });
});

test("HLS response detection covers MIME type, requested URL and redirect URL", () => {
  assert.equal(isHlsResponse(new Response("#EXTM3U", { headers: { "content-type": "application/vnd.apple.mpegurl" } }), "https://x/live"), true);
  assert.equal(isHlsResponse(new Response("x"), "https://x/live.m3u8"), true);
  assert.equal(isHlsResponse(new Response("x", { headers: { "content-type": "video/mp2t" } }), "https://x/live.ts"), false);
});

test("live-edge startup never replays older playlist segments after refresh", async () => {
  const requests = [];
  let playlistCalls = 0;
  const manifests = [
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:1,
100.ts
#EXTINF:1,
101.ts
#EXTINF:1,
102.ts
#EXTINF:1,
103.ts
#EXTINF:1,
104.ts
`,
    `#EXTM3U
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:101
#EXTINF:1,
101.ts
#EXTINF:1,
102.ts
#EXTINF:1,
103.ts
#EXTINF:1,
104.ts
#EXTINF:1,
105.ts
`,
  ];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("live.m3u8")) {
      const body = manifests[Math.min(playlistCalls, manifests.length - 1)];
      playlistCalls += 1;
      return new Response(body, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }
    const label = pathname.match(/(\d+)\.ts$/)?.[1] || "X";
    return new Response(tsChunk(label.slice(-1)), { status: 200, headers: { "content-type": "video/mp2t" } });
  };
  const controller = new AbortController();
  const initialResponse = await fetchImpl("https://provider.example/live.m3u8");
  const reader = await HlsMpegTsReader.create({
    fetchImpl,
    initialResponse,
    candidateUrl: "https://provider.example/live.m3u8",
    signal: controller.signal,
    userAgent: "test",
    liveEdgeSegments: 2,
  });

  const a = Buffer.from((await reader.read()).value);
  const b = Buffer.from((await reader.read()).value);
  const c = Buffer.from((await reader.read()).value);

  assert.ok(a.includes(Buffer.from("3333")));
  assert.ok(b.includes(Buffer.from("4444")));
  assert.ok(c.includes(Buffer.from("5555")));
  assert.equal(requests.some((url) => /\/100\.ts$|\/101\.ts$|\/102\.ts$/.test(url)), false);

  controller.abort();
  await reader.cancel();
});

test("AES-128 HLS segments are decrypted before entering the TS relay", async () => {
  const key = Buffer.from("0123456789abcdef");
  const sequence = 7;
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence, 12);
  const plain = tsChunk("D", 4);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);

  const manifest = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:${sequence}
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6,
seg.ts
#EXT-X-ENDLIST
`;

  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/key.bin")) return new Response(key, { status: 200 });
    if (pathname.endsWith("/seg.ts")) return new Response(encrypted, { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  };
  const controller = new AbortController();
  const reader = await HlsMpegTsReader.create({
    fetchImpl,
    initialResponse: new Response(manifest, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } }),
    candidateUrl: "https://provider.example/live.m3u8",
    signal: controller.signal,
    userAgent: "test",
  });
  const part = await reader.read();
  assert.equal(part.done, false);
  assert.deepEqual(Buffer.from(part.value), plain);
  assert.equal((await reader.read()).done, true);
  await reader.cancel();
});
