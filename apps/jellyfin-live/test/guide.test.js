import test from "node:test";
import assert from "node:assert/strict";
import { buildXmlTv, canonicalGuideName, guideCoverage, matchGuideChannel } from "../src/guide.js";
import { parseXmlTv } from "../src/organizer.js";

function doc(xml, sourceUrl) {
  const parsed = parseXmlTv(xml);
  parsed.sourceUrl = sourceUrl;
  return parsed;
}

const usDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="NESN.HD.us2"><display-name>NESN HD</display-name></channel>
  <channel id="Newsmax.TV.HD.us2"><display-name>Newsmax TV HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="NESN.HD.us2"><title>Red Sox Live</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="Newsmax.TV.HD.us2"><title>Newsmax Now</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz");

const ukDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="SkySp.F1.HD.uk"><display-name>Sky Sports F1 HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.F1.HD.uk"><title>Formula 1</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");

test("canonical guide names remove provider noise without losing the channel", () => {
  assert.equal(canonicalGuideName("NESN USA", "US"), "nesn");
  assert.equal(canonicalGuideName("Newsmax.TV.HD.us2", "US"), "newsmax");
  assert.equal(canonicalGuideName("SkySp.F1.HD.uk", "GB"), "sky sports f1");
});

test("guide matcher maps common playlist names to EPGShare ids", () => {
  assert.equal(matchGuideChannel({ name: "NESN USA", country: "US" }, [usDoc])?.id, "NESN.HD.us2");
  assert.equal(matchGuideChannel({ name: "Newsmax USA", country: "US" }, [usDoc])?.id, "Newsmax.TV.HD.us2");
  assert.equal(matchGuideChannel({ name: "Sky Sports F1 UK", country: "GB" }, [ukDoc])?.id, "SkySp.F1.HD.uk");
});

test("coverage counts channels with real programmes", () => {
  const lineup = [
    { id: "a", kind: "static", name: "NESN USA", country: "US", tvgId: "justone.a", logo: "" },
    { id: "b", kind: "static", name: "Unknown USA", country: "US", tvgId: "justone.b", logo: "" },
  ];
  const stats = guideCoverage(lineup, [usDoc]);
  assert.equal(stats.staticChannels, 2);
  assert.equal(stats.channelsWithPrograms, 1);
  assert.equal(stats.coveragePercent, 50);
});

test("sports XMLTV decodes nested entities and keeps event title searchable", () => {
  const lineup = [{
    id: "sport.cricket.01",
    kind: "sport-slot",
    tvgId: "justone.sport.cricket.01",
    name: "Cricket 01",
    logo: "https://example/channel.png",
    programmes: [{
      start: Date.UTC(2026, 7, 30, 11),
      end: Date.UTC(2026, 7, 30, 14),
      title: "Caribbean Premier League : Saint Kitts &amp; Nevis vs Antigua &amp;amp; Barbuda",
      subtitle: "Cricket",
      categories: ["Sports", "Cricket"],
      icon: "https://example/program.png",
    }],
  }];
  const xml = buildXmlTv(lineup, []);
  assert.match(xml, /Saint Kitts &amp; Nevis vs Antigua &amp; Barbuda/);
  assert.doesNotMatch(xml, /&amp;amp;/);
  assert.match(xml, /<category>Sports<\/category>/);
  assert.match(xml, /<keyword>Saint Kitts &amp; Nevis<\/keyword>/);
});
