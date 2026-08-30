import test from "node:test";
import assert from "node:assert/strict";
import { filterJellyfinRows, isVodStyleChannel } from "../src/filter.js";

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
