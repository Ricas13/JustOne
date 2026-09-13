import test from "node:test";
import assert from "node:assert/strict";

import { easyProxyHealth } from "../src/easyproxy.js";

test("HTTP 200 is unhealthy when the DLHD extractor failed to load", async () => {
  const result = await easyProxyHealth({
    fetchImpl: async () => new Response(JSON.stringify({
      status: "Working",
      version: "2.5.0",
      modules: { dlhd_extractor: false },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    timeoutMs: 500,
  });

  assert.equal(result.ok, false);
  assert.equal(result.dlhdExtractorLoaded, false);
});

test("engine is healthy only when EasyProxy and the DLHD extractor are ready", async () => {
  const result = await easyProxyHealth({
    fetchImpl: async () => new Response(JSON.stringify({
      status: "Working",
      version: "2.5.0",
      proxy: "HLS Proxy Server",
      modules: { dlhd_extractor: true },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    timeoutMs: 500,
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    version: "2.5.0",
    proxy: "HLS Proxy Server",
    dlhdExtractorLoaded: true,
  });
});
