import test from "node:test";
import assert from "node:assert/strict";
import { addCategory, eventIsSport, inferChannelCategory, needsSportsTag } from "../src/guide-categories.js";
import { config } from "../src/config.js";
import { enrichAndBuildGuide, parseXmlTv } from "../src/epg.js";

test("channel names infer generic Jellyfin categories", () => {
  assert.equal(inferChannelCategory({ name: "Sky Cinema Premiere" }), "Movie");
  assert.equal(inferChannelCategory({ name: "Nickelodeon" }), "Kids");
  assert.equal(inferChannelCategory({ name: "ESPN 2" }), "Sports");
  assert.equal(inferChannelCategory({ name: "Sky Sports Main Event" }), "Sports");
  assert.equal(inferChannelCategory({ name: "CNN International" }), "News");
  assert.equal(inferChannelCategory({ name: "BBC One" }), null);
});

test("addCategory adds once and respects onlyIfNone", () => {
  const p = `<programme channel="a"><title>T</title></programme>`;
  const once = addCategory(p, "Movie");
  assert.match(once, /<category>Movie<\/category>\s*<\/programme>/);
  assert.equal(addCategory(once, "Movie"), once);
  const tagged = `<programme channel="a"><title>T</title><category>Drama</category></programme>`;
  assert.equal(addCategory(tagged, "Movie", { onlyIfNone: true }), tagged);
});

test("event categories: music is not sport", () => {
  assert.equal(eventIsSport("Football"), true);
  assert.equal(eventIsSport("Music"), false);
});

function guide(extra = "") {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="c.uk"><display-name>Sky Cinema</display-name></channel>
    <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="c.uk"><title>Untagged</title></programme>
    <programme start="20260101010000 +0000" stop="20260101020000 +0000" channel="c.uk"><title>Tagged</title><category>Drama</category></programme></tv>`);
  const channels = [{ id: "c", key: "sky cinema", tvgId: "justone.c", name: "Sky Cinema", logo: "", aliasNames: [], variants: [{ originalTvgId: "c.uk" }] }];
  return enrichAndBuildGuide(channels, [{ id: "g", name: "G", parsed }], {});
}

test("guide gets inferred category only on untagged programmes", () => {
  const xml = guide();
  assert.match(xml, /<title>Untagged<\/title>[\s\S]*?<category>Movie<\/category>/);
  assert.equal((xml.match(/<category>Movie<\/category>/g) || []).length, 1);
});

test("GUIDE_CATEGORIES_ENABLED=false disables inference", () => {
  const prev = config.guideCategories.enabled;
  config.guideCategories.enabled = false;
  try { assert.doesNotMatch(guide(), /<category>Movie<\/category>/); }
  finally { config.guideCategories.enabled = prev; }
});

import { eventTypeFor } from "../src/finalize.js";
import { parseProtectedSchedule } from "../src/dlhd.js";

test("explicit Sports-branded channels beat Movie/Kids brand rules", () => {
  for (const name of ["Showtime Sports", "HBO Sports", "Nick Sports"]) assert.equal(inferChannelCategory({ name }), "Sports", name);
  assert.equal(inferChannelCategory({ name: "Disney Channel" }), "Kids");
});

test("addCategory ignores category-looking text in CDATA and comments", () => {
  const p = `<programme channel="a"><title>F</title><desc><![CDATA[See <category>News</category>]]></desc><!-- <category>Kids</category> --></programme>`;
  assert.match(addCategory(p, "Movie", { onlyIfNone: true }), /<category>Movie<\/category>\s*<\/programme>/);
});

test("football with 'Live From' in the title stays Football", () => {
  assert.equal(eventTypeFor({ category: "Football", name: "Premier League Live From Anfield" }), "Football");
  assert.equal(eventTypeFor({ category: "Football", name: "Live From Old Trafford: Manchester United vs Chelsea" }), "Football");
});

test("needsSportsTag: not for music, not when already Sports", () => {
  assert.equal(needsSportsTag("Music"), false);
  assert.equal(needsSportsTag("Sports"), false);
  assert.equal(needsSportsTag("Sport"), false);
  assert.equal(needsSportsTag("Football"), true);
});

test("double-encoded DLHD titles are fully decoded", () => {
  const payload = { "Sunday 13th Sep 2026": { Football: [{ event: "Brighton &amp;amp; Hove v X", time: "15:00", channels: [{ channel_id: "1", channel_name: "A" }] }] } };
  const { events } = parseProtectedSchedule(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].name ?? events[0].title, "Brighton & Hove v X");
});

function gapFill(category) {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="b.uk"><display-name>BBC One</display-name></channel></tv>`);
  const channels = [{ id: "b", key: "bbc one", tvgId: "justone.b", name: "BBC One", logo: "", aliasNames: [], dlhdRefId: "channel-b", referenceKind: "channel", variants: [{ originalTvgId: "b.uk" }] }];
  const dlhdReference = { linearEvents: [{ id: "g", name: "Gap Event", category, start: Date.UTC(2026, 8, 18, 20, 30), end: Date.UTC(2026, 8, 18, 22, 30), linkedStaticChannels: [{ id: "channel-b" }] }] };
  return enrichAndBuildGuide(channels, [{ id: "g", name: "G", parsed }], {}, { dlhdReference });
}

test("gap-fill programmes: music is not Sports, Sports is not duplicated, football gets one", () => {
  const music = gapFill("Music");
  assert.match(music, /<title>Gap Event<\/title>/);
  assert.doesNotMatch(music, /<category>Sports<\/category>/);
  assert.equal((gapFill("Sports").match(/<category>Sports<\/category>/g) || []).length, 1);
  assert.equal((gapFill("Football").match(/<category>Sports<\/category>/g) || []).length, 1);
});
