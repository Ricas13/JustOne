import test from "node:test";
import assert from "node:assert/strict";
import { buildXmlTv, canonicalGuideName, guideCoverage, matchGuideChannel } from "../src/guide.js";
import { parseXmlTv } from "../src/organizer.js";

const GUIDE_NOW = Date.UTC(2026, 7, 30, 10, 30);

function doc(xml, sourceUrl) {
  const parsed = parseXmlTv(xml);
  parsed.sourceUrl = sourceUrl;
  return parsed;
}

const usDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="NESN.HD.us2"><display-name>NESN HD</display-name></channel>
  <channel id="Newsmax.TV.HD.us2"><display-name>Newsmax TV HD</display-name></channel>
  <channel id="A.and.E.HD.East.us2"><display-name>A&amp;E HD East</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="NESN.HD.us2"><title>Red Sox Live</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="Newsmax.TV.HD.us2"><title>Newsmax Now</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="A.and.E.HD.East.us2"><title>Storage Wars</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz");

const ukDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="SkySp.F1.HD.uk"><display-name>Sky Sports F1 HD</display-name></channel>
  <channel id="ITV1.HD.uk"><display-name>ITV1 HD</display-name></channel>
  <channel id="Channel.5.uk"><display-name>Channel 5</display-name></channel>
  <channel id="Channel.5.HD.uk"><display-name>Channel 5 HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.F1.HD.uk"><title>Formula 1</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="ITV1.HD.uk"><title>Good Morning Britain</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="Channel.5.HD.uk"><title>Jeremy Vine</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");

const ptDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="RTP.Notícias.HD.pt"><display-name>RTP Notícias HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="RTP.Notícias.HD.pt"><title>Jornal das 12</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_PT1.xml.gz");

test("canonical guide names remove provider noise without losing the channel", () => {
  assert.equal(canonicalGuideName("NESN USA", "US"), "nesn");
  assert.equal(canonicalGuideName("Newsmax.TV.HD.us2", "US"), "newsmax");
  assert.equal(canonicalGuideName("SkySp.F1.HD.uk", "GB"), "sky sports f1");
  assert.equal(canonicalGuideName("A&E USA", "US"), "a and e");
});

test("guide matcher maps common playlist names to real EPG ids", () => {
  assert.equal(matchGuideChannel({ name: "NESN USA", country: "US" }, [usDoc])?.id, "NESN.HD.us2");
  assert.equal(matchGuideChannel({ name: "Newsmax USA", country: "US" }, [usDoc])?.id, "Newsmax.TV.HD.us2");
  assert.equal(matchGuideChannel({ name: "Sky Sports F1 UK", country: "GB" }, [ukDoc])?.id, "SkySp.F1.HD.uk");
  assert.equal(matchGuideChannel({ name: "ITV 1 UK", country: "GB" }, [ukDoc])?.id, "ITV1.HD.uk");
  assert.equal(matchGuideChannel({ name: "A&E USA", country: "US" }, [usDoc])?.id, "A.and.E.HD.East.us2");
  assert.equal(matchGuideChannel({ name: "RTP 3 Portugal", country: "PT" }, [ptDoc])?.id, "RTP.Notícias.HD.pt");
});

test("matcher prefers an equally good guide id that actually has programmes", () => {
  const hit = matchGuideChannel({ name: "Channel 5 UK", country: "GB" }, [ukDoc]);
  assert.equal(hit?.id, "Channel.5.HD.uk");
  assert.ok(hit?.programmeCount > 0);
});

test("guide matcher considers alternate source labels after channel dedupe", () => {
  const channel = {
    name: "Regional Sports USA",
    country: "US",
    candidates: [{ label: "NESN USA" }, { label: "Backup Feed" }],
  };
  assert.equal(matchGuideChannel(channel, [usDoc])?.id, "NESN.HD.us2");
});

test("coverage counts only channels with real programmes and reports countries", () => {
  const lineup = [
    { id: "a", kind: "static", name: "NESN USA", country: "US", tvgId: "justone.a", logo: "" },
    { id: "b", kind: "static", name: "Unknown USA", country: "US", tvgId: "justone.b", logo: "" },
    { id: "c", kind: "static", name: "Sky Sports F1 UK", country: "UK", tvgId: "justone.c", logo: "" },
  ];
  const stats = guideCoverage(lineup, [usDoc, ukDoc]);
  assert.equal(stats.staticChannels, 3);
  assert.equal(stats.channelsWithPrograms, 2);
  assert.equal(stats.coveragePercent, 66.7);
  assert.equal(stats.byCountry.US.staticChannels, 2);
  assert.equal(stats.byCountry.US.channelsWithPrograms, 1);
  assert.equal(stats.byCountry.US.coveragePercent, 50);
  assert.equal(stats.byCountry.GB.coveragePercent, 100);
  assert.equal(stats.byCountry.UK, undefined);
});

test("unmatched static channels get an honest current placeholder with artwork", () => {
  const lineup = [{
    id: "unknown",
    kind: "static",
    tvgId: "justone.unknown",
    name: "Unknown Channel",
    country: "GB",
    logo: "https://example/channel.png",
  }];
  const xml = buildXmlTv(lineup, [ukDoc], { now: GUIDE_NOW });
  assert.match(xml, /<channel id="justone\.unknown">/);
  assert.match(xml, /<programme start="20260830103000 \+0000"[^>]+channel="justone\.unknown"/);
  assert.match(xml, /<title>Schedule unavailable<\/title>/);
  assert.match(xml, /<sub-title>Unknown Channel<\/sub-title>/);
  assert.match(xml, /Detailed programme schedule is currently unavailable/);
  assert.match(xml, /<icon src="https:\/\/example\/channel\.png" \/>/);
  assert.match(xml, /<image type="backdrop"[^>]*>https:\/\/example\/channel\.png<\/image>/);
});

test("real external programmes still win over the fallback", () => {
  const lineup = [{
    id: "itv",
    kind: "static",
    tvgId: "justone.itv",
    name: "ITV 1 UK",
    country: "GB",
    logo: "https://example/itv.png",
  }];
  const xml = buildXmlTv(lineup, [ukDoc], { now: GUIDE_NOW });
  assert.match(xml, /Good Morning Britain/);
  assert.doesNotMatch(xml, /Detailed programme schedule is currently unavailable/);
  assert.match(xml, /<programme[^>]+channel="justone\.itv"/);
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
      scheduleSource: "dlstreams",
    }],
  }];
  const xml = buildXmlTv(lineup, [], { now: GUIDE_NOW });
  assert.match(xml, /Saint Kitts &amp; Nevis vs Antigua &amp; Barbuda/);
  assert.doesNotMatch(xml, /&amp;amp;/);
  assert.match(xml, /<category>Sports<\/category>/);
  assert.match(xml, /<keyword>Saint Kitts &amp; Nevis<\/keyword>/);
});

test("sports without a verified schedule do not get a fabricated programme time", () => {
  const lineup = [{
    id: "sport.football.unknown",
    kind: "sport-slot",
    tvgId: "justone.sport.football.unknown",
    name: "Unknown Final",
    logo: "https://example/channel.png",
    programmes: [],
  }];
  const xml = buildXmlTv(lineup, [], { now: GUIDE_NOW });
  assert.match(xml, /<channel id="justone\.sport\.football\.unknown">/);
  assert.doesNotMatch(xml, /<programme[^>]+channel="justone\.sport\.football\.unknown"/);
  assert.doesNotMatch(xml, /Schedule unavailable/);
});
