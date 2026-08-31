import test from "node:test";
import assert from "node:assert/strict";
import { liveStreamEndpoints } from "../src/resolve.js";

test("amddeus DLHD proxy is preferred while legacy resolver remains fallback", () => {
  assert.deepEqual(
    liveStreamEndpoints("123.ts", {
      proxyUrl: "http://dlhd-proxy:3000/",
      legacyUrl: "http://dlhd:3000/",
    }),
    [
      { provider: "amddeus-dlhd-proxy", url: "http://dlhd-proxy:3000/stream/123.m3u8" },
      { provider: "legacy-dlhd-web", url: "http://dlhd:3000/api/stream/123.m3u8" },
    ],
  );
});

test("legacy DLHD remains usable when the new proxy is not configured", () => {
  assert.deepEqual(
    liveStreamEndpoints("44.m3u8", { proxyUrl: "", legacyUrl: "http://dlhd:3000" }),
    [{ provider: "legacy-dlhd-web", url: "http://dlhd:3000/api/stream/44.m3u8" }],
  );
});
