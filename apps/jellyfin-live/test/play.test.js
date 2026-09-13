import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import {
  decodeBridgeTarget,
  easyProxyHealth,
  easyProxyManifestUrl,
  encodeBridgeTarget,
  isManifestResponse,
  proxyEasyProxyRequest,
  resolveEasyProxyManifest,
  rewriteEasyProxyManifest,
  rewriteJustOnePlaylistForEasyProxy,
} from "../src/easyproxy.js";

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
  }

  _write(chunk, _encoding, callback) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
    return this;
  }

  send(value) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(String(value)));
    this.end();
    return this;
  }

  json(value) {
    this.setHeader("content-type", "application/json");
    return this.send(JSON.stringify(value));
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function fakeRequest(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.aborted = false;
  return req;
}

test("EasyProxy manifest URL carries the original provider page", () => {
  const source = "https://daddylive.sx/watch.php?id=123&foo=bar";
  const url = new URL(easyProxyManifestUrl(source));

  assert.equal(url.origin, "http://easyproxy:7860");
  assert.equal(url.pathname, "/proxy/manifest.m3u8");
  assert.equal(url.searchParams.get("url"), source);
});

test("Jellyfin playlist advertises HLS rather than the removed MPEG-TS engine", () => {
  const input = [
    "#EXTM3U",
    "#EXTINF:-1,Example",
    "https://resolver.example/jellyfin/play/channel.abc.ts?key=secret",
    "#EXTINF:-1,Other",
    "https://resolver.example/jellyfin/play/channel.def.ts",
    "",
  ].join("\n");

  const output = rewriteJustOnePlaylistForEasyProxy(input);
  assert.match(output, /channel\.abc\.m3u8\?key=secret/);
  assert.match(output, /channel\.def\.m3u8/);
  assert.doesNotMatch(output, /\/jellyfin\/play\/[^\n]+\.ts(?:\?|$)/);
});

test("bridge tokens are signed and cannot be tampered with", () => {
  const target = "http://easyproxy:7860/key?key_url=https%3A%2F%2Fexample.test%2Fkey.bin";
  const token = encodeBridgeTarget(target);

  assert.equal(decodeBridgeTarget(token).href, target);
  assert.throws(() => decodeBridgeTarget(`${token}x`), /signature|token/);
  assert.throws(() => encodeBridgeTarget("https://attacker.example/segment.ts"), /EasyProxy/);
});

test("EasyProxy manifest rewrites keys, maps, media renditions, child manifests and segments", () => {
  const body = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="http://easyproxy:7860/key?key_url=https%3A%2F%2Fkeys.test%2Fone"',
    '#EXT-X-MAP:URI="http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Finit.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Faudio.m3u8"',
    "#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO=\"a\"",
    "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fvideo.m3u8",
    "#EXTINF:6,",
    "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fseg.ts%3Ftoken%3Dabc",
    "",
  ].join("\n");

  const rewritten = rewriteEasyProxyManifest(body);
  assert.equal((rewritten.match(/\/jellyfin\/proxy\//g) || []).length, 5);
  assert.doesNotMatch(rewritten, /http:\/\/easyproxy:7860\/(?:key|proxy)/);
  assert.match(rewritten, /#EXT-X-KEY:METHOD=AES-128,URI="http:\/\/localhost:8090\/jellyfin\/proxy\//);
  assert.match(rewritten, /#EXT-X-MAP:URI="http:\/\/localhost:8090\/jellyfin\/proxy\//);
  assert.match(rewritten, /#EXT-X-MEDIA:[^\n]+URI="http:\/\/localhost:8090\/jellyfin\/proxy\//);
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

test("invalid and non-HLS candidates cannot be promoted", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(new URL(url).searchParams.get("url"));
    return new Response("<html>not media</html>", { status: 200, headers: { "content-type": "text/html" } });
  };

  await assert.rejects(
    resolveEasyProxyManifest([
      { label: "invalid", url: "not-a-url" },
      { label: "html", url: "https://daddylive.sx/watch.php?id=20" },
    ], { fetchImpl, timeoutMs: 5_000 }),
    /all EasyProxy candidates failed.*invalid HLS manifest/,
  );
  assert.deepEqual(requested, ["https://daddylive.sx/watch.php?id=20"]);
});

test("EasyProxy proxy route is not mistaken for a manifest when it carries TS bytes", () => {
  const segmentTarget = new URL(
    "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fseg.ts",
  );
  const segmentResponse = new Response(new Uint8Array([0x47, 0x40, 0x00]), {
    status: 200,
    headers: { "content-type": "video/mp2t" },
  });
  assert.equal(isManifestResponse(segmentTarget, segmentResponse), false);

  const manifestTarget = new URL(
    "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fchild.m3u8",
  );
  const badlyLabelledManifest = new Response("#EXTM3U", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(isManifestResponse(manifestTarget, badlyLabelledManifest), true);
});

test("bridge streams byte ranges and preserves 206 response headers", async () => {
  const target = "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fseg.ts";
  const token = encodeBridgeTarget(target);
  const req = fakeRequest({ range: "bytes=10-12", "user-agent": "Jellyfin-test" });
  const res = new FakeResponse();
  let seenHeaders;

  await proxyEasyProxyRequest(req, res, token, {
    fetchImpl: async (_url, options) => {
      seenHeaders = options.headers;
      return new Response(new Uint8Array([0x47, 0x01, 0x02]), {
        status: 206,
        headers: {
          "content-type": "video/mp2t",
          "content-range": "bytes 10-12/100",
          "accept-ranges": "bytes",
        },
      });
    },
  });

  assert.equal(seenHeaders.range, "bytes=10-12");
  assert.equal(seenHeaders["user-agent"], "Jellyfin-test");
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers.get("content-range"), "bytes 10-12/100");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.concat(res.chunks), Buffer.from([0x47, 0x01, 0x02]));
});

test("bridge propagates upstream segment errors instead of turning them into manifests", async () => {
  const target = "http://easyproxy:7860/proxy/manifest.m3u8?url=https%3A%2F%2Fmedia.test%2Fmissing.ts";
  const req = fakeRequest();
  const res = new FakeResponse();

  await proxyEasyProxyRequest(req, res, encodeBridgeTarget(target), {
    fetchImpl: async () => new Response("missing", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }),
  });

  assert.equal(res.statusCode, 404);
  assert.equal(res.text(), "missing");
});

test("EasyProxy health reports outages without throwing", async () => {
  const down = await easyProxyHealth({
    fetchImpl: async () => { throw new Error("connection refused"); },
    timeoutMs: 500,
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /connection refused/);

  const unhealthy = await easyProxyHealth({
    fetchImpl: async () => new Response("bad", { status: 503 }),
    timeoutMs: 500,
  });
  assert.deepEqual(unhealthy, { ok: false, status: 503 });
});
