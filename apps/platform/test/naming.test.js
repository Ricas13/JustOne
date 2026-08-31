import test from "node:test";
import assert from "node:assert/strict";
import { slugTvgId } from "../src/naming.js";

test("slugTvgId creates stable Live TV identifiers", () => {
  assert.equal(slugTvgId("BBC One HD (UK)"), "bbc.one.hd.uk");
  assert.equal(slugTvgId("  ESPN++  "), "espn");
});

test("slugTvgId caps identifiers at 48 characters", () => {
  assert.equal(slugTvgId("A".repeat(100)).length, 48);
});
