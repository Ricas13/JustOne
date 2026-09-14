import test from "node:test";
import assert from "node:assert/strict";
import { rankFromName } from "../src/dispatcharr.js";

test("Dispatcharr reconciler reads JustOne stream rank", () => {
  assert.equal(rankFromName("BBC One [JO:007] [HD]"), 7);
  assert.ok(rankFromName("BBC One") > 1000000);
});
