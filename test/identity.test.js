import test from "node:test";
import assert from "node:assert/strict";
import { canonicalIdentity, countryOf, isBackup, qualityOf, strippedChannelName } from "../src/identity.js";

test("quality and backup variants collapse to one canonical channel", () => {
  const names = ["UK: BBC One FHD", "BBC One HD", "BBC One Backup HD", "BBC One SD"];
  const ids = names.map((name) => canonicalIdentity({ name, tvgName: "", group: "UK" }).key);
  assert.deepEqual(new Set(ids).size, 1);
  assert.equal(strippedChannelName("BBC One Backup HD"), "BBC One");
  assert.equal(qualityOf("BBC One FHD"), "FHD");
  assert.equal(isBackup("BBC One Backup HD"), true);
});

test("country detection recognises target-country metadata and tvg-id suffixes", () => {
  assert.equal(countryOf({ name:"BBC One", group:"United Kingdom" }), "GB");
  assert.equal(countryOf({ name:"RTP 1", group:"Portugal" }), "PT");
  assert.equal(countryOf({ name:"ESPN", group:"USA Sports" }), "US");
  assert.equal(countryOf({ name:"BBC One", group:"General", tvgId:"bbc1.uk" }), "GB");
  assert.equal(countryOf({ name:"RTP 1", group:"General", tvgId:"rtp1.pt" }), "PT");
  assert.equal(countryOf({ name:"ESPN", group:"General", tvgId:"espn.us" }), "US");
});
