import assert from "node:assert/strict";
import test from "node:test";
import { buildMetadataLineup, buildMetadataM3u, ensureUniqueTvgIds } from "../src/metadata-only.js";

test("byte-identical repeated source rows still receive unique tvg ids", () => {
  const raw = Array.from({ length: 12 }, () => ({
    name: "Repeated Sports Feed",
    tvgName: "Repeated Sports Feed",
    tvgId: "dlhd-104",
    group: "UK",
    url: "https://resolver.vpn4u.cc/play/live/104.ts?key=exact",
  }));

  const lineup = buildMetadataLineup(raw, { iptvOrg: null, excludeAdult: true });
  const ids = lineup.map((row) => row.tvgId);

  assert.equal(lineup.length, 12);
  assert.equal(new Set(ids).size, 12, "every displayed row must have a unique XMLTV identity");
  assert.equal(ids[0], "dlhd-104", "the first source keeps the provider identity when possible");
  assert.ok(ids.slice(1).every((id) => /^dlhd-104\.justone\.[0-9a-f]{8}$/.test(id)));
  assert.ok(lineup.slice(1).every((row) => row.sourceTvgIds.includes("dlhd-104")));
  assert.deepEqual(
    lineup.map((row) => row.url),
    raw.map((row) => row.url),
    "identity cleanup must not alter or deduplicate playback URLs",
  );
});

test("final identity normalization is idempotent and never touches playback", () => {
  const rows = [
    { id: "a", tvgId: "shared.guide", sourceTvgIds: [], name: "A", group: "TV", url: "https://example/a.ts" },
    { id: "b", tvgId: "shared.guide", sourceTvgIds: [], name: "B", group: "TV", url: "https://example/b.ts" },
    { id: "c", tvgId: "shared.guide", sourceTvgIds: [], name: "C", group: "TV", url: "https://example/c.ts" },
  ];
  const urls = rows.map((row) => row.url);

  ensureUniqueTvgIds(rows);
  const once = rows.map((row) => row.tvgId);
  ensureUniqueTvgIds(rows);

  assert.equal(new Set(rows.map((row) => row.tvgId)).size, rows.length);
  assert.deepEqual(rows.map((row) => row.tvgId), once, "running the invariant twice must not keep suffixing ids");
  assert.deepEqual(rows.map((row) => row.url), urls);
  assert.ok(rows[1].sourceTvgIds.includes("shared.guide"));
  assert.ok(rows[2].sourceTvgIds.includes("shared.guide"));
});

test("M3U output preserves all repeated playback rows while advertising unique tvg ids", () => {
  const raw = [
    { name: "Feed 1", tvgId: "same", group: "TV", url: "https://example/same.ts" },
    { name: "Feed 2", tvgId: "same", group: "TV", url: "https://example/same.ts" },
    { name: "Feed 3", tvgId: "same", group: "TV", url: "https://example/same.ts" },
  ];
  const lineup = buildMetadataLineup(raw, { iptvOrg: null, excludeAdult: true });
  const m3u = buildMetadataM3u(lineup);
  const ids = [...m3u.matchAll(/tvg-id="([^"]+)"/g)].map((m) => m[1]);
  const urls = m3u.split(/\r?\n/).filter((line) => /^https?:\/\//.test(line));

  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(urls, raw.map((row) => row.url));
});
