import test from "node:test";
import assert from "node:assert/strict";

import { buildAttempts } from "../src/play.js";

test("playback attempts are strictly sequential and preserve candidate order", () => {
  const attempts = buildAttempts({
    name: "Example",
    candidates: [
      { label: "first", url: "http://dlhd-proxy:3000/stream/10.m3u8" },
      { label: "second", url: "http://dlhd-proxy:3000/stream/11.m3u8?token=x" },
    ],
  }, 2);

  assert.deepEqual(
    attempts.map((row) => [row.candidateIndex, row.source, new URL(row.url).pathname, new URL(row.url).searchParams.get("source")]),
    [
      [0, 0, "/stream/10.m3u8", "0"],
      [0, 1, "/stream/10.m3u8", "1"],
      [1, 0, "/stream/11.m3u8", "0"],
      [1, 1, "/stream/11.m3u8", "1"],
    ],
  );
  assert.equal(new URL(attempts[2].url).searchParams.get("token"), "x");
});

test("invalid candidate URLs are ignored rather than reordered", () => {
  const attempts = buildAttempts({
    candidates: [
      { label: "bad", url: "" },
      { label: "good", url: "https://example.test/live.m3u8" },
    ],
  }, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].candidateIndex, 1);
  assert.equal(attempts[0].source, 0);
});

test("fixed candidates are attempted once without a DLHD source parameter", () => {
  const url = "http://mediaflow-proxy:8888/proxy/acestream/stream?infohash=abc";
  const attempts = buildAttempts({
    id: "channel.example",
    candidates: [
      {
        label: "AceStream example",
        url,
        provider: "acestream",
        sourceMode: "fixed",
        sourceCount: 1,
        infohash: "abc",
      },
    ],
  }, 2);

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, url);
  assert.equal(attempts[0].provider, "acestream");
  assert.equal(attempts[0].channelId, "channel.example");
  assert.equal(new URL(attempts[0].url).searchParams.has("source"), false);
});
