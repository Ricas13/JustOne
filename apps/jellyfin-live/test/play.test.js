import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAttempts,
  ffmpegArgs,
  refreshAttemptUrl,
  resultMeansNoMoreSources,
  resultShouldRefreshSource,
} from "../src/play.js";

test("ffmpeg maps only the primary video and audio streams", () => {
  const args = ffmpegArgs("http://dlhd-proxy:3000/stream/49.m3u8?source=0");
  const maps = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-map") maps.push(args[index + 1]);
  }

  assert.deepEqual(maps, ["0:v:0?", "0:a:0?"]);
});

test("ffmpeg read timeout leaves enough room for bounded proxy recovery", () => {
  const args = ffmpegArgs("http://dlhd-proxy:3000/stream/49.m3u8?source=0");
  const index = args.indexOf("-rw_timeout");
  assert.notEqual(index, -1);
  assert.ok(Number(args[index + 1]) >= 20_000_000);
});

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

test("default playback exhausts seven ordered provider sources before the next candidate", () => {
  const attempts = buildAttempts({
    name: "Example",
    candidates: [
      { label: "first", url: "http://dlhd-proxy:3000/stream/10.m3u8" },
      { label: "second", url: "http://dlhd-proxy:3000/stream/11.m3u8" },
    ],
  });

  assert.equal(attempts.length, 14);
  assert.deepEqual(
    attempts.slice(0, 8).map((row) => [row.candidateIndex, row.source]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [1, 0],
    ],
  );
});

test("source count is capped at seven", () => {
  const attempts = buildAttempts({
    candidates: [
      { label: "good", url: "https://example.test/live.m3u8" },
    ],
  }, 20);

  assert.equal(attempts.length, 7);
  assert.deepEqual(attempts.map((row) => row.source), [0, 1, 2, 3, 4, 5, 6]);
});

test("404 before media means this candidate has no additional provider source slots", () => {
  assert.equal(resultMeansNoMoreSources({
    bytes: 0,
    detail: "code=8 signal=none [http @ x] HTTP error 404 Not Found",
  }), true);

  assert.equal(resultMeansNoMoreSources({
    bytes: 188,
    detail: "[http @ x] HTTP error 404 Not Found",
  }), false);

  assert.equal(resultMeansNoMoreSources({
    bytes: 0,
    detail: "[http @ x] HTTP error 502 Bad Gateway",
  }), false);
});

test("transient failures refresh the same source before failover", () => {
  assert.equal(resultShouldRefreshSource({
    bytes: 0,
    reason: "ffmpeg-exit",
    detail: "HTTP error 503 Service Unavailable",
  }), true);
  assert.equal(resultShouldRefreshSource({
    bytes: 0,
    reason: "ffmpeg-exit",
    detail: "Operation timed out when parsing playlist",
  }), true);
  assert.equal(resultShouldRefreshSource({
    bytes: 1024,
    reason: "ffmpeg-exit",
    detail: "code=0 signal=none",
  }), true);
  assert.equal(resultShouldRefreshSource({
    bytes: 0,
    reason: "ffmpeg-exit",
    detail: "HTTP error 404 Not Found",
  }), false);
});

test("refresh retry preserves source selection while forcing resolver refresh", () => {
  const url = refreshAttemptUrl("http://dlhd-proxy:3000/stream/35.m3u8?source=0&token=x");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("source"), "0");
  assert.equal(parsed.searchParams.get("token"), "x");
  assert.equal(parsed.searchParams.get("refresh"), "1");
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
