import test from "node:test";
import assert from "node:assert/strict";
import { canonicalIdentity, isBackup, qualityOf, strippedChannelName } from "../src/identity.js";

test("quality and backup variants collapse to one canonical channel", () => {
  const names = ["UK: BBC One FHD", "BBC One HD", "BBC One Backup HD", "BBC One SD"];
  const ids = names.map((name) => canonicalIdentity({ name, tvgName: "", group: "UK" }).key);
  assert.deepEqual(new Set(ids).size, 1);
  assert.equal(strippedChannelName("BBC One Backup HD"), "BBC One");
  assert.equal(qualityOf("BBC One FHD"), "FHD");
  assert.equal(isBackup("BBC One Backup HD"), true);
});
