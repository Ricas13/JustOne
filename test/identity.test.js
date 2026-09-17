import test from "node:test";
import assert from "node:assert/strict";
import { canonicalIdentity, countryGroup, countryName, countryOf, isBackup, qualityOf, stripCountryDecoration, strippedChannelName } from "../src/identity.js";

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

test("explicit foreign channel identity outranks a target-country provider group", () => {
  assert.equal(countryOf({ name:"EuroSport 1 Greece", group:"PT Sports" }), "GR");
  assert.equal(countryOf({ name:"TNT Sports Argentina", group:"UK Sports" }), "AR");
  assert.equal(countryOf({ name:"MTV Poland", group:"USA Entertainment" }), "PL");
  assert.equal(countryOf({ name:"Star TV Turkey", group:"PT General" }), "TR");
  assert.equal(countryOf({ name:"ESPN 1 NL", group:"USA Sports" }), "NL");
});


test("global country detection recognises additional DLHD countries without treating interior short words as country codes", () => {
  assert.equal(countryOf({ name:"Canal+ Foot France" }), "FR");
  assert.equal(countryOf({ name:"beIN Sports 2 Malaysia" }), "MY");
  assert.equal(countryOf({ name:"ON Sport Max Egypt" }), "EG");
  assert.equal(countryOf({ name:"Win+ Futbol Colombia" }), "CO");
  assert.equal(countryOf({ name:"Sports In Motion", group:"General" }), "");
  assert.equal(countryName("FR"), "France");
  assert.equal(countryGroup("FR"), "TV | France");
  assert.equal(countryGroup("GB"), "TV | UK");
});


test("country decoration stripping removes complete edge countries without damaging ordinary words", () => {
  assert.equal(stripCountryDecoration("Canal+ Foot France"), "canal foot");
  assert.equal(stripCountryDecoration("France | Canal+ Foot"), "canal foot");
  assert.equal(stripCountryDecoration("MY: beIN Sports 2"), "bein sports 2");
  assert.equal(stripCountryDecoration("South Park"), "south park");
  assert.equal(stripCountryDecoration("North Sports Network"), "north sports network");
});


test("explicit edge country codes outrank ambiguous country-name words", () => {
  assert.equal(countryOf({ name:"Georgia Bulldogs USA" }), "US");
  assert.equal(countryOf({ name:"Jordan Sports USA" }), "US");
  assert.equal(countryOf({ name:"Georgia Public TV" }), "GE");
});
