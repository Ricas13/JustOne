import test from "node:test";
import assert from "node:assert/strict";
import { orderVariantsBreadthFirst } from "../src/catalog.js";

const sources = [
  { id: "a1", name: "A1", provider: "A", priority: 10 },
  { id: "a2", name: "A2", provider: "A", priority: 20 },
  { id: "b1", name: "B1", provider: "B", priority: 10 },
];

function v(sourceId, quality, backup = false) {
  return { sourceId, name: `${sourceId}-${quality}-${backup}`, quality, backup, url: `http://${sourceId}/${quality}/${backup}` };
}

test("failover order prioritises independent families before deeper variants", () => {
  const ordered = orderVariantsBreadthFirst([
    v("a1", "HD"), v("a1", "FHD"),
    v("a2", "HD"), v("a2", "FHD"),
    v("b1", "HD"), v("b1", "FHD"),
  ], sources, ["HD", "FHD", "SD", "UNKNOWN"]);
  assert.deepEqual(ordered.map((x) => `${x.sourceId}:${x.quality}`), [
    "a1:HD", "b1:HD", "a2:HD", "a1:FHD", "b1:FHD", "a2:FHD",
  ]);
});
