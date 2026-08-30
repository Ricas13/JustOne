import assert from "node:assert/strict";
import test from "node:test";
import { parseLiveHlsPlaylist } from "../src/play.js";

const base = "https://live.example/channel/index.m3u8";

test("rolling HLS uses media sequence rather than reusable segment filenames", () => {
  const first = parseLiveHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:5,
segment0.ts
#EXTINF:5,
segment1.ts
#EXTINF:5,
segment2.ts
`,
    base,
  );

  const next = parseLiveHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:103
#EXTINF:5,
segment0.ts
#EXTINF:5,
segment1.ts
#EXTINF:5,
segment2.ts
`,
    base,
  );

  assert.deepEqual(first.segments.map((segment) => segment.url), next.segments.map((segment) => segment.url));
  assert.deepEqual(first.segments.map((segment) => segment.key), ["seq:100", "seq:101", "seq:102"]);
  assert.deepEqual(next.segments.map((segment) => segment.key), ["seq:103", "seq:104", "seq:105"]);
  assert.equal(first.targetDuration, 5);
});

test("program date time provides identity when media sequence is omitted", () => {
  const first = parseLiveHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-PROGRAM-DATE-TIME:2026-08-30T20:00:00Z
segment.ts
`,
    base,
  );
  const next = parseLiveHlsPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-PROGRAM-DATE-TIME:2026-08-30T20:00:05Z
segment.ts
`,
    base,
  );

  assert.equal(first.segments[0].url, next.segments[0].url);
  assert.notEqual(first.segments[0].key, next.segments[0].key);
});

test("master playlists are distinguished from media segment playlists", () => {
  const parsed = parseLiveHlsPlaylist(
    `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000
low/index.m3u8
`,
    base,
  );

  assert.equal(parsed.isMaster, true);
  assert.equal(parsed.segments.length, 0);
  assert.deepEqual(parsed.refs, [
    "https://live.example/channel/high/index.m3u8",
    "https://live.example/channel/low/index.m3u8",
  ]);
});
