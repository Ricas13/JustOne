import test from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_URL = "http://resolver.test";
process.env.PLAYLIST_KEY = "";
process.env.LIVE_HLS_RENEW_INTERVAL_MS = "4000";
process.env.LIVE_HLS_RENEW_BUDGET_MS = "3000";
process.env.LIVE_HLS_RENEW_RETRY_DELAY_MS = "100";

const {
  listHlsPlaylistTargets,
  proxyRenewableLiveAsset,
  renewablePlaylistToken,
  resetRenewableLiveForTests,
  rewriteRenewableManifest,
} = await import("../src/renewableLive.js?renewable-live-test=1");

function childUrl(body) {
  return String(body)
    .split(/\r?\n/)
    .find((line) => line.startsWith("/play/renew/") && line.includes(".m3u8"));
}

function tokenPath(url) {
  return new URL(url, "http://resolver.test").pathname.split("/").pop();
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: "",
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.headersSent = true;
      this.writableEnded = true;
      this.body = JSON.stringify(value);
      return this;
    },
    end(value = "") {
      this.headersSent = true;
      this.writableEnded = true;
      this.body += Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("playlist selector order is stable across media and stream-inf entries", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/live.m3u8"',
    "#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO=\"audio\"",
    "video/main.m3u8",
    "",
  ].join("\n");

  assert.deepEqual(listHlsPlaylistTargets(master, "https://cdn.example/master.m3u8"), [
    "https://cdn.example/audio/live.m3u8",
    "https://cdn.example/video/main.m3u8",
  ]);
});

test("signed child URL changes keep the same local client-facing renewable playlist identity", () => {
  resetRenewableLiveForTests();
  const rootUrl = "http://dlhd-proxy:3000/stream/425.m3u8";
  const first = rewriteRenewableManifest(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nhttps://xameleon.example/secure/token-a/mono.m3u8\n",
    rootUrl,
    { channelId: "425", rootUrl },
  );
  const second = rewriteRenewableManifest(
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nhttps://xameleon.example/secure/token-b/mono.m3u8\n",
    rootUrl,
    { channelId: "425", rootUrl },
  );

  assert.equal(childUrl(first), childUrl(second));
  assert.ok(childUrl(first).startsWith("/play/renew/"));
  assert.ok(!childUrl(first).includes("resolver.test"), "renewable child must not hairpin through PUBLIC_URL");
  assert.equal(
    tokenPath(childUrl(first)).replace(/\.m3u8$/, ""),
    renewablePlaylistToken("425", rootUrl, [0]),
  );
});

test("expired signed playlist is re-resolved behind the same stable client URL", async () => {
  resetRenewableLiveForTests();
  const originalFetch = globalThis.fetch;
  const rootUrl = "http://dlhd-proxy:3000/stream/425.m3u8";
  const signedA = "https://xameleon.example/secure/token-a/mono.m3u8";
  const signedB = "https://xameleon.example/secure/token-b/mono.m3u8";
  const masterA = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\n${signedA}\n`;
  const masterB = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\n${signedB}\n`;
  const mediaB = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:4,\nsegment-10.ts\n";

  const rewrittenRoot = rewriteRenewableManifest(masterA, rootUrl, {
    channelId: "425",
    rootUrl,
  });
  const stableChild = childUrl(rewrittenRoot);
  assert.ok(stableChild, "root master exposes a stable renewable child playlist");

  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === signedA) return new Response("expired", { status: 500 });
    if (value === rootUrl) {
      return new Response(masterB, {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (value === signedB) {
      return new Response(mediaB, {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };

  try {
    const req = { method: "GET", headers: {} };
    const res = fakeResponse();
    await proxyRenewableLiveAsset(req, res, tokenPath(stableChild));

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-justone-hls-renewal"], "current");
    assert.match(res.body, /#EXT-X-MEDIA-SEQUENCE:10/);
    assert.match(res.body, /\/play\/renew\/.+\.ts/);
    assert.ok(!res.body.includes("resolver.test/play/renew/"));
    assert.deepEqual(calls, [signedA, rootUrl, signedB]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
