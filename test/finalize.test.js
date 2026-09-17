import test from "node:test";
import assert from "node:assert/strict";
import { eventPresentation, eventTypeFor, finalizeSnapshot, syncGuideEvents } from "../src/finalize.js";

test("event classifier normalizes DLHD generic categories into sports groups", () => {
  assert.equal(eventTypeFor({ name:"Soccer : Southampton vs Ipswich Town", category:"Events" }), "Football");
  assert.equal(eventTypeFor({ name:"Serbia Super Liga : RK Jugovic vs RK Metaloplastika", category:"Handball" }), "Handball");
  assert.equal(eventTypeFor({ name:"European Championships : Slovakia vs Czech Republic", category:"Volleyball" }), "Volleyball");
  assert.equal(eventTypeFor({ name:"WTA 250 Sao Paulo", category:"Events" }), "Tennis");
  assert.equal(eventTypeFor({ name:"World Athletics Ultimate Championships", category:"Events" }), "Athletics");
  assert.equal(eventTypeFor({ name:"Rock in Rio Lisbon 2026", category:"Events" }), "Music");
  assert.equal(eventTypeFor({ name:"Jeopardy! S43, E1 Premiere", category:"TV Shows" }), "TV & Entertainment");
});

test("event presentation keeps the actual fixture as channel title", () => {
  assert.deepEqual(eventPresentation("⚽ 🇬🇧 England - Premier League : Sporting vs Benfica"), {
    title: "Sporting vs Benfica",
    competition: "England - Premier League",
  });
  assert.equal(eventPresentation("Soccer : Southampton vs Ipswich Town").title, "Southampton vs Ipswich Town");
  assert.equal(eventPresentation("WTA 250 Sao Paulo").title, "WTA 250 Sao Paulo");
});

test("finalizer orders UK then PT then USA then the remaining countries and never materializes linked events", () => {
  const variant = (sourceId, url) => ({ sourceId, url, name:"HD", quality:"HD", backup:false, order:0 });
  const snapshot = {
    channels: [
      { id:"us", key:"us", tvgId:"justone.us", name:"ABC USA", group:"TV | US", dlhdRefId:"usref", dlhdId:"51", referenceKind:"channel", aliasNames:["ABC USA"], variants:[variant("a","http://a/us")] },
      { id:"pt", key:"pt", tvgId:"justone.pt", name:"RTP 1 Portugal", group:"TV | PT", dlhdRefId:"ptref", dlhdId:"79", referenceKind:"channel", aliasNames:["RTP 1 Portugal"], variants:[variant("a","http://a/pt")] },
      { id:"gb", key:"gb", tvgId:"justone.gb", name:"TNT Sports 1 UK", group:"TV | GB", dlhdRefId:"gbref", dlhdId:"31", referenceKind:"channel", aliasNames:["TNT Sports 1 UK"], variants:[variant("a","http://a/gb")] },
      { id:"de", key:"de", tvgId:"justone.de", name:"Sky Sport Mix DE", group:"TV | Germany", dlhdRefId:"deref", dlhdId:"131", referenceKind:"channel", aliasNames:["Sky Sport Mix DE"], variants:[variant("a","http://a/de")] },
      { id:"fr", key:"fr", tvgId:"justone.fr", name:"Canal+ Foot France", group:"TV | France", dlhdRefId:"frref", dlhdId:"132", referenceKind:"channel", aliasNames:["Canal+ Foot France"], variants:[variant("a","http://a/fr")] },
      { id:"direct", key:"direct", tvgId:"justone.event.direct", name:"WTA 250 Sao Paulo", group:"Events | Events", dlhdRefId:"direct", referenceKind:"event", variants:[variant("a","http://a/tennis")], event:{ start:2000, end:3000, category:"Events", originalName:"WTA 250 Sao Paulo" } },
    ],
    dlhdReference: {
      channels: [],
      events: [
        { id:"direct", key:"direct", tvgId:"justone.event.direct", name:"WTA 250 Sao Paulo", category:"Events", start:2000, end:3000, linkedChannels:[] },
      ],
      linearEvents: [
        { id:"linear", name:"Southampton vs Ipswich Town", category:"Football", start:1000, end:4000, linkedStaticChannels:[{ id:"gbref", name:"TNT Sports 1 UK" }] },
      ],
    },
    dlhdStatus: {
      matchedChannelReferences:5,
      matchedEventReferences:1,
      matchedReferences:6,
      outputMappings:6,
      unmatchedReferences:[],
    },
  };

  const { snapshot: result, addedEvents } = finalizeSnapshot(snapshot, { overrides:{} });
  assert.equal(addedEvents.length, 0);
  assert.equal(result.channels.length, 6);
  assert.deepEqual(result.channels.slice(0,5).map((x)=>x.group), [
    "TV | UK", "TV | PT", "TV | USA", "TV | France", "TV | Germany",
  ]);
  assert.deepEqual(result.channels.slice(0,5).map((x)=>x.number), [1000,2000,3000,4000,4001]);
  assert.equal(result.channels[5].group, "Events | Tennis");
  assert.equal(result.channels[5].number, 90000);
  assert.match(result.channels[5].logo, /:8092\/artwork\/event\/channel\/direct\.png/);
  assert.match(result.channels[5].event.programmeArtwork, /:8092\/artwork\/event\/program\/direct\.png/);
  assert.equal(result.dlhdStatus.matchedEventReferences, 1);
  assert.equal(result.dlhdStatus.linkedChannelFallbackEvents, 0);
  assert.equal(result.dlhdStatus.linearScheduleEvents, 1);
});

test("event guide contains exactly one event-only programme with poster artwork", () => {
  const channel = {
    id:"fallback",
    tvgId:"justone.event.fallback",
    name:"Southampton vs Ipswich Town",
    logo:"http://justone-catalog:8092/artwork/event/channel/fallback.png",
    referenceKind:"event",
    event:{
      start:Date.UTC(2026,8,15,19,0),
      end:Date.UTC(2026,8,15,22,0),
      category:"Football",
      competition:"Premier League",
      programmeArtwork:"http://justone-catalog:8092/artwork/event/program/fallback.png",
    },
  };
  const original = `<?xml version="1.0"?><tv generator-info-name="JustOne Catalog">
    <channel id="justone.event.fallback"><display-name>Old Name</display-name></channel>
    <programme start="20260915070000 +0000" stop="20260915110000 +0000" channel="justone.event.fallback"><title>Wrong broadcaster filler</title></programme>
    <programme start="20260915120000 +0000" stop="20260915130000 +0000" channel="justone.static"><title>Real static programme</title></programme>
  </tv>`;
  const xml = syncGuideEvents(original, [channel]);
  assert.match(xml, /<display-name>Southampton vs Ipswich Town<\/display-name>/);
  assert.match(xml, /<title>Southampton vs Ipswich Town<\/title>/);
  assert.match(xml, /<sub-title>Premier League<\/sub-title>/);
  assert.match(xml, /artwork\/event\/program\/fallback\.png/);
  assert.doesNotMatch(xml, /Wrong broadcaster filler/);
  assert.match(xml, /Real static programme/);
  assert.equal((xml.match(/channel="justone\.event\.fallback"/g) || []).length, 1);
});
