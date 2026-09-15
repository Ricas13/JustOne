import test from "node:test";
import assert from "node:assert/strict";
import { eventArtworkPng } from "../src/artwork.js";

function dimensions(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const channel = {
  id:"sporting-benfica",
  name:"Sporting vs Benfica",
  event:{ category:"Football", competition:"Liga Portugal" },
};

test("event channel artwork is a square PNG", () => {
  const png = eventArtworkPng(channel, "channel");
  assert.deepEqual(dimensions(png), { width:512, height:512 });
  assert.ok(png.length > 1000);
});

test("event programme artwork is a widescreen PNG", () => {
  const png = eventArtworkPng(channel, "program");
  assert.deepEqual(dimensions(png), { width:1200, height:675 });
  assert.ok(png.length > 1000);
});
