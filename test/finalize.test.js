import test from "node:test";
import assert from "node:assert/strict";
import { augmentGuideWithEvents, eventTypeFor, finalizeSnapshot } from "../src/finalize.js";

test("event classifier normalizes DLHD generic categories into sports groups", () => {
  assert.equal(eventTypeFor({ name:"Soccer : Southampton vs Ipswich Town", category:"Events" }), "Football");
  assert.equal(eventTypeFor({ name:"Serbia Super Liga : RK Jugovic vs RK Metaloplastika", category:"Handball" }), "Handball");
  assert.equal(eventTypeFor({ name:"European Championships : Slovakia vs Czech Republic", category:"Volleyball" }), "Volleyball");
  assert.equal(eventTypeFor({ name:"WTA 250 Sao Paulo", category:"Events" }), "Tennis");
  assert.equal(eventTypeFor({ name:"World Athletics Ultimate Championships", category:"Events" }), "Athletics");
  assert.equal(eventTypeFor({ name:"Rock in Rio Lisbon 2026", category:"Events" }), "Music");
  assert.equal(eventTypeFor({ name:"Jeopardy! S43, E1 Premiere", category:"TV Shows" }), "TV & Entertainment");
});

test("finalizer orders UK then PT then USA then grouped events and materializes linked events", () => {
  const variant = (sourceId, url) => ({ sourceId, url, name:"HD", quality:"HD", backup:false, order:0 });
  const snapshot = {
    channels: [
      { id:"us", key:"us", tvgId:"justone.us", name:"ABC USA", group:"TV | US", dlhdRefId:"usref", dlhdId:"51", referenceKind:"channel", aliasNames:["ABC USA"], variants:[variant("a","http://a/us")] },
      { id:"pt", key:"pt", tvgId:"justone.pt", name:"RTP 1 Portugal", group:"TV | PT", dlhdRefId:"ptref", dlhdId:"79", referenceKind:"channel", aliasNames:["RTP 1 Portugal"], variants:[variant("a","http://a/pt")] },
      { id:"gb", key:"gb", tvgId:"justone.gb", name:"TNT Sports 1 UK", group:"TV | GB", dlhdRefId:"gbref", dlhdId:"31", referenceKind:"channel", aliasNames:["TNT Sports 1 UK"], variants:[variant("a","http://a/gb")] },
      { id:"direct", key:"direct", tvgId:"justone.event.direct", name:"WTA 250 Sao Paulo", group:"Events | Events", dlhdRefId:"direct", referenceKind:"event", variants:[variant("a","http://a/tennis")], event:{ start:2000, end:3000, category:"Events" } },
    ],
    dlhdReference: {
      channels: [],
      events: [
        { id:"direct", key:"direct", tvgId:"justone.event.direct", name:"WTA 250 Sao Paulo", category:"Events", start:2000, end:3000, linkedChannels:[] },
        { id:"fallback", key:"fallback", tvgId:"justone.event.fallback", name:"Soccer : Southampton vs Ipswich Town", category:"Events", start:1000, end:4000, aliases:["Soccer : Southampton vs Ipswich Town","TNT Sports 1 UK"], linkedChannels:[{ id:"31", name:"TNT Sports 1 UK" }] },
      ],
    },
    dlhdStatus: {
      matchedChannelReferences:3,
      matchedEventReferences:1,
      matchedReferences:4,
      outputMappings:4,
      unmatchedReferences:[{ id:"fallback", kind:"event", name:"Soccer : Southampton vs Ipswich Town" }],
    },
  };

  const { snapshot: result, addedEvents } = finalizeSnapshot(snapshot, { overrides:{} });
  assert.equal(addedEvents.length, 1);
  assert.equal(result.channels.length, 5);
  assert.deepEqual(result.channels.slice(0,3).map((x)=>x.group), ["TV | UK","TV | PT","TV | USA"]);
  assert.deepEqual(result.channels.slice(0,3).map((x)=>x.number), [1000,2000,3000]);
  assert.equal(result.channels[3].group, "Events | Football");
  assert.equal(result.channels[4].group, "Events | Tennis");
  assert.deepEqual(result.channels.slice(3).map((x)=>x.number), [90000,90001]);
  assert.equal(result.channels[3].linkedChannelFallback, true);
  assert.equal(result.channels[3].variants[0].url, "http://a/gb");
  assert.equal(result.dlhdStatus.matchedEventReferences, 2);
  assert.equal(result.dlhdStatus.linkedChannelFallbackEvents, 1);
  assert.equal(result.dlhdStatus.unmatchedReferences.length, 0);
});

test("linked fallback events get their own XMLTV channel and scheduled programme", () => {
  const channel = {
    tvgId:"justone.event.fallback",
    name:"Soccer : Southampton vs Ipswich Town",
    logo:"https://logo.example/event.png",
    event:{ start:Date.UTC(2026,8,15,19,0), end:Date.UTC(2026,8,15,22,0), category:"Football" },
  };
  const original = '<?xml version="1.0"?><tv generator-info-name="JustOne"></tv>\n';
  const xml = augmentGuideWithEvents(original, [channel]);
  assert.match(xml, /<channel id="justone\.event\.fallback">/);
  assert.match(xml, /<programme .*channel="justone\.event\.fallback">/);
  assert.match(xml, /<category>Football<\/category>/);
  assert.match(xml, /Southampton vs Ipswich Town/);
});
