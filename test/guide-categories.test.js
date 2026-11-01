import test from "node:test";
import assert from "node:assert/strict";
import { eventTypeFor } from "../src/finalize.js";
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

function gapFill(category, name = "Gap Event") {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="b.uk"><display-name>BBC One</display-name></channel></tv>`);
  const channels = [{ id: "b", key: "bbc one", tvgId: "justone.b", name: "BBC One", logo: "", aliasNames: [], dlhdRefId: "channel-b", referenceKind: "channel", variants: [{ originalTvgId: "b.uk" }] }];
  const dlhdReference = { linearEvents: [{ id: "g", name, category, start: Date.UTC(2026, 8, 18, 20, 30), end: Date.UTC(2026, 8, 18, 22, 30), linkedStaticChannels: [{ id: "channel-b" }] }] };
  return enrichAndBuildGuide(channels, [{ id: "g", name: "G", parsed }], {}, { dlhdReference });
}

test("gap-fill programmes: music is not Sports, Sports is not duplicated, football gets one", () => {
  const music = gapFill("Music");
  assert.match(music, /<title>Gap Event<\/title>/);
  assert.doesNotMatch(music, /<category>Sports<\/category>/);
  assert.equal((gapFill("Sports").match(/<category>Sports<\/category>/g) || []).length, 1);
  assert.equal((gapFill("Football").match(/<category>Sports<\/category>/g) || []).length, 1);
});

test("addCategory inserts before the real closing tag, not a fake one in CDATA or a comment", () => {
  const p = `<programme channel="c"><desc><![CDATA[fake </programme> end]]></desc><!-- </programme> --><title>F</title></programme>`;
  const out = addCategory(p, "Movie", { onlyIfNone: true });
  assert.ok(out.endsWith("<category>Movie</category>\n</programme>"), out);
});

test("generic 'Events' category: festival titles are not Sports, sport titles are", () => {
  assert.equal(needsSportsTag("Events", "Coachella 2026"), false);
  assert.equal(needsSportsTag("Events", "Arsenal vs Chelsea"), true);
  assert.equal(needsSportsTag("", "Glastonbury Live"), false);
  assert.equal(needsSportsTag("Football", "Festival of Football"), true);
});

test("gap-fill with generic Events category and a music title gets no Sports tag", () => {
  const music = gapFill("Events", "Coachella 2026");
  assert.match(music, /<title>Coachella 2026<\/title>/);
  assert.doesNotMatch(music, /<category>Sports<\/category>/);
  assert.equal((gapFill("Events", "Arsenal vs Chelsea").match(/<category>Sports<\/category>/g) || []).length, 1);
});

test("BBL stays Cricket when the category says Cricket", () => {
  assert.equal(eventTypeFor({ category: "Cricket", name: "BBL: Sydney Sixers vs Perth Scorchers" }), "Cricket");
});

test("clear sport evidence beats non-sport title words under a generic category", () => {
  assert.equal(needsSportsTag("Events", "NBA Season Opener"), true);
  assert.equal(needsSportsTag("Events", "Music City Bowl"), true);
  assert.equal(needsSportsTag("Events", "F1 Festival of Speed"), true);
  assert.equal(needsSportsTag("Events", "Coachella 2026"), false);
});

test("mixed-content brands (AMC, HBO) are not inferred as Movie; film channels still are", () => {
  assert.equal(inferChannelCategory({ name: "AMC" }), null);
  assert.equal(inferChannelCategory({ name: "HBO" }), null);
  assert.equal(inferChannelCategory({ name: "HBO Movies" }), "Movie");
  assert.equal(inferChannelCategory({ name: "Film4" }), "Movie");
});

test("addCategory scans malformed XML in linear time", () => {
  const a = '<programme channel="a"><title>A</title>' + "<category>not-closed ".repeat(40000) + "</programme>";
  const b = '<programme channel="a">' + "<!-- x ".repeat(40000) + "</programme>";
  const t = Date.now();
  addCategory(a, "Movie", { onlyIfNone: true });
  addCategory(b, "Movie", { onlyIfNone: true });
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

test("unfinished <category openings are scanned in linear time", () => {
  const x = '<programme channel="c"><title>F</title>' + "<category lang='en' ".repeat(40000) + "</programme>";
  const t = Date.now();
  addCategory(x, "Movie", { onlyIfNone: true });
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`); // quadratic scanning takes tens of seconds here
});

test("a provider category closed with '</category >' is preserved", () => {
  const p = '<programme channel="a"><category lang="en">Drama</category ></programme>';
  assert.equal(addCategory(p, "Movie", { onlyIfNone: true }), p);
});

test("music titles with ambiguous words (open, v, league) are not Sports", () => {
  for (const t of ["Open Air Music Festival 2026", "Open Air Concert", "V Festival", "League of Legends Music Festival", "Open Mic Music Night"]) {
    assert.equal(needsSportsTag("Events", t), false, t);
  }
  assert.equal(needsSportsTag("Events", "Arsenal v Chelsea"), true);
});

test("final event classification keeps clear sport evidence over entertainment words", () => {
  assert.equal(eventTypeFor({ category: "Events", name: "Music City Bowl" }), "American Football");
  assert.equal(eventTypeFor({ category: "Events", name: "Premier League Season Preview" }), "Football");
  assert.equal(eventTypeFor({ category: "Events", name: "Coachella 2026" }), "Music");
});

test("bowl venues and concerts are not American football; named bowl games are", () => {
  assert.equal(eventTypeFor({ category: "Music", name: "Hollywood Bowl Concert: London Philharmonic" }), "Music");
  assert.equal(eventTypeFor({ category: "Music", name: "Super Bowl Halftime Concert" }), "Music");
  assert.equal(eventTypeFor({ category: "Rugby", name: "Rugby Sevens Bowl Final" }), "Rugby");
  assert.equal(eventTypeFor({ category: "Events", name: "Music City Bowl" }), "American Football");
  assert.equal(eventTypeFor({ category: "Events", name: "Rose Bowl" }), "American Football");
  assert.equal(eventTypeFor({ category: "Events", name: "Champions League of Legends Concert" }), "Music");
});

test("many closed comments or CDATA sections are scanned in linear time", () => {
  for (const unit of ["<!--ok-->", "<![CDATA[ok]]>"]) {
    const x = "<programme><title>F</title>" + unit.repeat(40000) + "</programme>";
    const t = Date.now();
    addCategory(x, "Movie", { onlyIfNone: true });
    assert.ok(Date.now() - t < 1000, `${unit} took ${Date.now() - t}ms`); // quadratic scanning takes several seconds here
  }
});

test("an empty provider <category></category> does not suppress inference", () => {
  assert.match(addCategory("<programme><category></category></programme>", "Movie", { onlyIfNone: true }), /<category>Movie<\/category>/);
});

test("a CDATA-wrapped provider category is preserved; an empty CDATA one is not", () => {
  const tagged = "<programme><category><![CDATA[Drama]]></category></programme>";
  assert.equal(addCategory(tagged, "Movie", { onlyIfNone: true }), tagged);
  assert.match(addCategory("<programme><category><![CDATA[]]></category></programme>", "Movie", { onlyIfNone: true }), /<category>Movie<\/category>/);
  // category-looking text inside CDATA still does not count
  assert.match(addCategory("<programme><desc><![CDATA[<category>News</category>]]></desc></programme>", "Movie", { onlyIfNone: true }), /<category>Movie<\/category>\s*<\/programme>/);
});
