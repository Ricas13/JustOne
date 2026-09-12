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

test("default playback exhausts six ordered provider sources before the next candidate", () => {
  const attempts = buildAttempts({
    name: "Example",
    candidates: [
      { label: "first", url: "http://dlhd-proxy:3000/stream/10.m3u8" },
      { label: "second", url: "http://dlhd-proxy:3000/stream/11.m3u8" },
    ],
  });

  assert.equal(attempts.length, 12);
  assert.deepEqual(
    attempts.slice(0, 7).map((row) => [row.candidateIndex, row.source]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [1, 0],
    ],
  );
});

test("source count is capped at six", () => {
  const attempts = buildAttempts({
    candidates: [
      { label: "good", url: "https://example.test/live.m3u8" },
    ],
  }, 20);

  assert.equal(attempts.length, 6);
  assert.deepEqual(attempts.map((row) => row.source), [0, 1, 2, 3, 4, 5]);
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
