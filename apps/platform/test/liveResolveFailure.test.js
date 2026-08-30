import test from "node:test";
import assert from "node:assert/strict";
import { resolveLive } from "../src/resolve.js";

test("forced live refresh evicts stale cache and never accepts a DLHD 503 as a stream", async () => {
  const originalFetch = globalThis.fetch;
  const id = "998501";
  let mode = "good";
  let calls = 0;

  globalThis.fetch = async (url, options = {}) => {
    calls += 1;
    assert.match(String(url), new RegExp(`/api/stream/${id}\\.m3u8$`));
    assert.equal(options.redirect, "manual");

    if (mode === "good") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://media.example/live.m3u8",
          "x-dlhd-delivery": "direct",
          "x-dlhd-source": "stream",
          "x-dlhd-attempt": "1",
        },
      });
    }

    return new Response("no playable source", {
      status: 503,
      headers: { "x-dlhd-failover": "exhausted" },
    });
  };

  try {
    const first = await resolveLive(id, { force: true });
    assert.equal(first.url, "https://media.example/live.m3u8");
    assert.equal(first.validated, true);

    mode = "failed";
    const failed = await resolveLive(id, { force: true });
    assert.equal(failed.url, null);
    assert.equal(failed.providerStatus, 503);
    assert.equal(failed.liveFailure, "sources-exhausted");
    assert.equal(failed.failover, "exhausted");

    const afterFailure = await resolveLive(id);
    assert.equal(afterFailure.url, null);
    assert.equal(afterFailure.providerStatus, 503);
    assert.equal(calls, 3, "a failed forced refresh must remove the previous cached source");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live resolver rejects a non-redirect success response instead of proxying the resolver endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const id = "998502";

  globalThis.fetch = async () =>
    new Response("not a redirect", {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
    });

  try {
    const result = await resolveLive(id, { force: true });
    assert.equal(result.url, null);
    assert.equal(result.providerStatus, 200);
    assert.equal(result.liveFailure, "resolver-http-200");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
