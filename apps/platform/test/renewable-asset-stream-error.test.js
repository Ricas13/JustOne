import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  proxyRenewableLiveAsset,
  resetRenewableLiveForTests,
  rewriteRenewableManifest,
} from "../src/renewableLive.js";

function tokenFromRewrittenManifest(manifest) {
  const match = String(manifest).match(/\/play\/renew\/([^?\s]+?)(?:\.[a-z0-9]{1,8})?(?:\?|$)/i);
  assert.ok(match, "rewritten manifest should contain a renewable asset token");
  return match[1].replace(/\.[a-z0-9]{1,8}$/i, "");
}

function responseSink() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.writeHead = (statusCode) => {
    res.statusCode = statusCode;
    res.headersSent = true;
    return res;
  };
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.body = () => Buffer.concat(chunks);
  return res;
}

test("renewable asset body failure is contained instead of becoming an unhandled stream error", async () => {
  resetRenewableLiveForTests();
  const previousFetch = global.fetch;
  try {
    const rewritten = rewriteRenewableManifest(
      "#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/live/segment-1.ts\n",
      "https://cdn.example/live/index.m3u8",
      { channelId: "387", rootUrl: "https://cdn.example/live/index.m3u8", selectorPath: [] },
    );
    const token = tokenFromRewrittenManifest(rewritten);

    global.fetch = async () => ({
      status: 200,
      url: "https://cdn.example/live/segment-1.ts",
      headers: new Headers({ "content-type": "video/mp2t" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x47, 0x00, 0x00, 0x00]));
          queueMicrotask(() => controller.error(new DOMException("simulated body timeout", "TimeoutError")));
        },
      }),
    });

    const req = { method: "GET", headers: {} };
    const res = responseSink();
    await proxyRenewableLiveAsset(req, res, `${token}.ts`);

    assert.equal(res.headersSent, true, "upstream response headers should have been forwarded");
    assert.equal(res.destroyed, true, "failed streaming response should be destroyed locally");
  } finally {
    global.fetch = previousFetch;
    resetRenewableLiveForTests();
  }
});
