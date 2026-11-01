import test from "node:test";
import assert from "node:assert/strict";
import { addCategory, eventIsSport, inferChannelCategory } from "../src/guide-categories.js";
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
