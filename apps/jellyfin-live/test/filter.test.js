import test from "node:test";
import assert from "node:assert/strict";
import {
  filterJellyfinRows,
  isAdultStyleChannel,
  isFreeStyleChannel,
  isIptvOrgStyleChannel,
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

test("adult rows are removed", () => {
  assert.equal(isAdultStyleChannel({ name: "18+ Example", group: "Adult" }), true);
  assert.equal(isAdultStyleChannel({ name: "Brazzers TV", group: "International" }), true);
  assert.equal(isAdultStyleChannel({ name: "Babestation", group: "UK" }), true);
  assert.deepEqual(
    filterJellyfinRows([
      { name: "18+ Example", group: "Adult" },
      { name: "BBC One UK", group: "UK" },
    ]).map((x) => x.name),
    ["BBC One UK"],
  );
});

test("free-channel providers and explicit free groups are removed", () => {
  for (const ch of [
    { name: "Random Channel", group: "Free Channels" },
    { name: "Pluto TV Action", group: "USA" },
    { name: "Samsung TV Plus News", group: "USA" },
    { name: "Plex Live TV", group: "International" },
  ]) {
    assert.equal(isFreeStyleChannel(ch), true, ch.name);
  }
  assert.equal(isFreeStyleChannel({ name: "FreeSports UK", group: "UK" }), false);
});

test("IPTV-org source rows are removed without disabling IPTV-org metadata enrichment", () => {
  assert.equal(isIptvOrgStyleChannel({ name: "Example", group: "IPTV-Org" }), true);
  assert.equal(isIptvOrgStyleChannel({ name: "IPTV Org Example", group: "International" }), true);
  assert.equal(isIptvOrgStyleChannel({ name: "Example", group: "UK", url: "https://iptv-org.github.io/example.m3u" }), true);
  assert.equal(isIptvOrgStyleChannel({ name: "BBC One UK", group: "UK", url: "https://resolver.example/play/live/1.ts" }), false);
});
