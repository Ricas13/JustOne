import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCountryCode, organizeLineup } from "../src/lineup.js";

test("sports stay first and static channels are ordered USA UK Portugal then other countries", () => {
  const lineup = [
    { id: "sport", kind: "sport-slot", name: "Football 01", group: "Sports | Football", number: 100 },
    { id: "fr", kind: "static", name: "TF1", country: "FR", group: "TV | FR", number: 3000 },
    { id: "pt", kind: "static", name: "RTP 1", country: "PT", group: "TV | PT", number: 2200 },
    { id: "gb", kind: "static", name: "BBC One", country: "GB", group: "TV | GB", number: 2000 },
    { id: "us", kind: "static", name: "ESPN", country: "US", group: "TV | US", number: 2400 },
  ];
  const out = organizeLineup(lineup);
  assert.deepEqual(out.map((x) => x.id), ["sport", "us", "gb", "pt", "fr"]);
  assert.deepEqual(out.slice(1).map((x) => x.group), ["USA", "UK", "Portugal", "France"]);
  assert.deepEqual(out.slice(1).map((x) => x.number), [1000, 2000, 3000, 4000]);
});

test("UK and GB are one country bucket", () => {
  const out = organizeLineup([
    { id: "a", kind: "static", name: "BBC One", country: "GB" },
    { id: "b", kind: "static", name: "ITV 1 UK", country: "UK" },
  ]);
  assert.deepEqual(out.map((x) => x.country), ["GB", "GB"]);
  assert.deepEqual(out.map((x) => x.group), ["UK", "UK"]);
});

test("known ambiguous channel names get the correct country", () => {
  assert.equal(normalizeCountryCode("US", "5 USA"), "GB");
  assert.equal(normalizeCountryCode("GB", "BBC America (BBCA)"), "US");
  assert.equal(normalizeCountryCode("UK", "ITV 1 UK"), "GB");
});
