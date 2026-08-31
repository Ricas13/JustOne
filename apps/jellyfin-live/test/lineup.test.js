import test from "node:test";
import assert from "node:assert/strict";
import {
  currentChannelName,
  isLinearSportsChannel,
  normalizeCountryCode,
  organizeLineup,
} from "../src/lineup.js";

test("sports stay first and TV is ordered USA UK Portugal then other countries", () => {
  const lineup = [
    { id: "sport", kind: "sport-slot", name: "Arsenal vs Chelsea", group: "Football", number: 100 },
    { id: "fr", kind: "static", name: "TF1 France", country: "FR", group: "France", number: 3000 },
    { id: "pt", kind: "static", name: "RTP 1 Portugal", country: "PT", group: "Portugal", number: 2200 },
    { id: "gb", kind: "static", name: "BBC One UK", country: "GB", group: "UK", number: 2000 },
    { id: "us", kind: "static", name: "ABC USA", country: "US", group: "USA", number: 2400 },
  ];
  const out = organizeLineup(lineup);
  assert.deepEqual(out.map((x) => x.id), ["sport", "us", "gb", "pt", "fr"]);
  assert.deepEqual(out.map((x) => x.group), [
    "Sports | Football",
    "TV | USA",
    "TV | UK",
    "TV | Portugal",
    "TV | France",
  ]);
  assert.deepEqual(out.map((x) => x.number), [100, 1000, 2000, 3000, 4000]);
});

test("sports event groups get generated logos and programme artwork", () => {
  const [event] = organizeLineup([
    {
      id: "football-01",
      kind: "static",
      name: "Chelsea vs Luton Town - Sky Sports Football UK",
      country: "GB",
      group: "Football",
      logo: "https://provider.example/logo.png",
      url: "https://resolver.example/play/live/501.ts?key=secret&token=x%2Fy",
    },
  ]);

  assert.equal(event.kind, "sport-slot");
  assert.equal(event.eventStyle, true);
  assert.equal(event.group, "Sports | Football");
  assert.match(event.logo, /\/jellyfin\/artwork\/channel\/football-01\.png/);
  assert.equal(event.logoSource, "generated-sports-event");
  assert.equal(event.programmes.length, 1);
  assert.equal(event.programmes[0].title, "Chelsea vs Luton Town");
  assert.match(event.programmes[0].icon, /\/jellyfin\/artwork\/program\/football-01\.event\.0\.png/);
  assert.deepEqual(event.programmes[0].categories.slice(0, 2), ["Sports", "Football"]);
  assert.equal(event.url, "https://resolver.example/play/live/501.ts?key=secret&token=x%2Fy");
});

test("existing scheduled sports programmes keep timing but receive consistent generated artwork", () => {
  const start = Date.UTC(2026, 7, 30, 18, 0);
  const end = Date.UTC(2026, 7, 30, 20, 0);
  const [event] = organizeLineup([
    {
      id: "tennis-01",
      kind: "sport-slot",
      name: "ATP - Singles",
      group: "Tennis",
      programmes: [{ start, end, title: "Aleksandar Vukic vs Rei Sakamoto", categories: ["Tennis"] }],
      url: "https://resolver.example/play/live/777.ts",
    },
  ]);

  assert.equal(event.programmes[0].start, start);
  assert.equal(event.programmes[0].end, end);
  assert.equal(event.programmes[0].title, "Aleksandar Vukic vs Rei Sakamoto");
  assert.match(event.programmes[0].icon, /\/jellyfin\/artwork\/program\/tennis-01\.event\.0\.png/);
});

test("sports event groups are separated without pulling linear sports networks out of countries", () => {
  const out = organizeLineup([
    { id: "f1", kind: "static", name: "Formula 1 - Sky Sports F1 UK", country: "GB", group: "Formula 1", url: "https://example/f1" },
    { id: "ufc", kind: "static", name: "UFC 999 - Main Event", country: "US", group: "MMA", url: "https://example/ufc" },
    { id: "espn", kind: "static", name: "ESPN USA", country: "US", group: "USA", url: "https://example/espn" },
    { id: "sporttv", kind: "static", name: "Sport TV 1 Portugal", country: "PT", group: "Portugal", url: "https://example/sporttv" },
    { id: "sky", kind: "static", name: "Sky Sports Main Event UK", country: "GB", group: "Sports", url: "https://example/sky" },
  ]);

  assert.equal(out.find((x) => x.id === "f1")?.group, "Sports | Motorsport");
  assert.equal(out.find((x) => x.id === "ufc")?.group, "Sports | Boxing & MMA");
  assert.equal(out.find((x) => x.id === "espn")?.group, "TV | USA");
  assert.equal(out.find((x) => x.id === "sporttv")?.group, "TV | Portugal");
  assert.equal(out.find((x) => x.id === "sky")?.group, "TV | UK");
  assert.equal(out.find((x) => x.id === "sky")?.kind, "static");
});

test("common sports networks are recognized as linear channels", () => {
  for (const name of [
    "Sky Sports Main Event UK",
    "Sport TV 1 Portugal",
    "ESPN USA",
    "TNT Sports 1 UK",
    "DAZN 1 Portugal",
    "Eurosport 1 UK",
    "beIN Sports 1",
  ]) {
    assert.equal(isLinearSportsChannel({ name }), true, name);
  }
});

test("organisation preserves raw playback URLs exactly", () => {
  const url = "https://resolver.example/play/live/501.ts?key=abc123&token=x%2Fy";
  const [channel] = organizeLineup([
    { id: "raw", kind: "static", name: "BBC One UK", country: "GB", group: "UK", url },
  ]);
  assert.equal(channel.url, url);
});

test("country suffixes are removed from display names once the group already identifies the country", () => {
  const out = organizeLineup([
    { id: "bbc", kind: "static", name: "BBC One UK", country: "GB" },
    { id: "rtp", kind: "static", name: "RTP 1 Portugal HD", country: "PT" },
    { id: "abc", kind: "static", name: "ABC USA", country: "US" },
    { id: "fiveusa", kind: "static", name: "5 USA", country: "US" },
  ]);
  assert.equal(out.find((x) => x.id === "bbc")?.name, "BBC One");
  assert.equal(out.find((x) => x.id === "rtp")?.name, "RTP 1 HD");
  assert.equal(out.find((x) => x.id === "abc")?.name, "ABC");
  assert.equal(out.find((x) => x.id === "fiveusa")?.name, "5 USA");
});

test("explicit 24/7 rows get their own tidy section", () => {
  const out = organizeLineup([
    { id: "uk247", kind: "static", name: "Classic TV 24/7 UK", country: "GB", group: "24/7", url: "https://example/uk" },
    { id: "intl247", kind: "static", name: "Nature 24/7", country: "", group: "24/7", url: "https://example/int" },
  ]);
  assert.equal(out.find((x) => x.id === "uk247")?.group, "24/7 | UK");
  assert.equal(out.find((x) => x.id === "intl247")?.group, "24/7");
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
  assert.deepEqual(out.map((x) => x.group), ["TV | UK", "TV | UK"]);
});

test("known ambiguous channel names get the correct country", () => {
  assert.equal(normalizeCountryCode("US", "5 USA"), "GB");
  assert.equal(normalizeCountryCode("GB", "BBC America (BBCA)"), "US");
  assert.equal(normalizeCountryCode("UK", "ITV 1 UK"), "GB");
});
