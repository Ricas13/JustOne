import test from "node:test";
import assert from "node:assert/strict";
import {
  filterJellyfinRows,
  isAdultStyleChannel,
  isVodStyleChannel,
} from "../src/filter.js";

test("VOD-style groups are removed", () => {
  const rows = [
    { name: "Some Film", group: "Movies" },
    { name: "Episode S1E1", group: "TV Shows" },
    { name: "Box Set", group: "Provider / Series" },
    { name: "On Demand", group: "VOD" },
    { name: "BBC One UK", group: "UK" },
  ];
  assert.deepEqual(filterJellyfinRows(rows).map((x) => x.name), ["BBC One UK"]);
});

test("linear movie channels are retained", () => {
  for (const ch of [
    { name: "AXN Movies Portugal", group: "Portugal" },
    { name: "Lifetime Movies Network", group: "24/7" },
    { name: "Yes Movies Action Israel", group: "Israel" },
  ]) {
    assert.equal(isVodStyleChannel(ch), false, ch.name);
  }
});

test("adult detection remains available to the configurable metadata layer", () => {
  assert.equal(isAdultStyleChannel({ name: "18+ Example", group: "Adult" }), true);
  assert.equal(isAdultStyleChannel({ name: "Brazzers TV", group: "International" }), true);
  assert.equal(isAdultStyleChannel({ name: "Babestation", group: "UK" }), true);
});

test("source-family labels do not make valid Live TV rows disappear", () => {
  const rows = [
    { name: "Pluto TV Action", group: "USA", url: "https://example/pluto" },
    { name: "Samsung TV Plus News", group: "Free Channels", url: "https://example/samsung" },
    { name: "IPTV Org Example", group: "IPTV-Org", url: "https://iptv-org.github.io/example.m3u" },
    { name: "BBC One UK", group: "UK", url: "https://resolver.example/play/live/1.ts" },
  ];

  assert.deepEqual(filterJellyfinRows(rows).map((x) => x.name), rows.map((x) => x.name));
});
