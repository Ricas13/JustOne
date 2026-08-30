import test from "node:test";
import assert from "node:assert/strict";
import { currentChannelName, normalizeCountryCode, organizeLineup } from "../src/lineup.js";

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

test("Portugal follows familiar terrestrial order before secondary channels", () => {
  const out = organizeLineup([
    { id: "sicn", kind: "static", name: "SIC Noticias Portugal", country: "PT" },
    { id: "tvi", kind: "static", name: "TVI Portugal", country: "PT" },
    { id: "rtp2", kind: "static", name: "RTP 2 Portugal", country: "PT" },
    { id: "sic", kind: "static", name: "SIC Portugal", country: "PT" },
    { id: "rtp3", kind: "static", name: "RTP 3 Portugal", country: "PT" },
    { id: "rtp1", kind: "static", name: "RTP 1 Portugal", country: "PT" },
  ]);
  assert.deepEqual(out.map((x) => x.id), ["rtp1", "rtp2", "sic", "tvi", "rtp3", "sicn"]);
});

test("Portuguese Eleven channels use current DAZN names", () => {
  assert.equal(currentChannelName("PT", "Eleven Sports 1 Portugal"), "DAZN 1");
  assert.equal(currentChannelName("PT", "ELEVEN 4 HD"), "DAZN 4");
  assert.equal(currentChannelName("PT", "DAZN Eleven 6"), "DAZN 6");

  const out = organizeLineup([
    { id: "e2", kind: "static", name: "Eleven Sports 2 Portugal", country: "PT" },
    { id: "e1", kind: "static", name: "Eleven Sports 1 Portugal", country: "PT" },
  ]);
  assert.deepEqual(out.map((x) => x.name), ["DAZN 1", "DAZN 2"]);
});

test("Eleven branding outside Portugal is not rewritten", () => {
  assert.equal(currentChannelName("PL", "Eleven Sports 1"), "Eleven Sports 1");
  assert.equal(currentChannelName("BE", "Eleven Sports 1"), "Eleven Sports 1");
});

test("UK follows familiar main-channel order", () => {
  const out = organizeLineup([
    { id: "itv2", kind: "static", name: "ITV 2 UK", country: "GB" },
    { id: "five", kind: "static", name: "Channel 5 UK", country: "GB" },
    { id: "bbc2", kind: "static", name: "BBC Two UK", country: "GB" },
    { id: "four", kind: "static", name: "Channel 4 UK", country: "GB" },
    { id: "itv1", kind: "static", name: "ITV 1 UK", country: "GB" },
    { id: "bbc1", kind: "static", name: "BBC One UK", country: "GB" },
  ]);
  assert.deepEqual(out.map((x) => x.id), ["bbc1", "bbc2", "itv1", "four", "five", "itv2"]);
});

test("Spain follows familiar national channel order", () => {
  const out = organizeLineup([
    { id: "six", kind: "static", name: "La Sexta Spain", country: "ES" },
    { id: "five", kind: "static", name: "Telecinco Spain", country: "ES" },
    { id: "a3", kind: "static", name: "Antena 3 Spain", country: "ES" },
    { id: "la1", kind: "static", name: "La 1 Spain", country: "ES" },
    { id: "cuatro", kind: "static", name: "Cuatro Spain", country: "ES" },
    { id: "la2", kind: "static", name: "La 2 Spain", country: "ES" },
  ]);
  assert.deepEqual(out.map((x) => x.id), ["la1", "la2", "a3", "cuatro", "five", "six"]);
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
