import test from "node:test";
import assert from "node:assert/strict";
import { enrichAndBuildGuide, epgHintsForChannelId, isGeneratedJustOneGuide, parseXmlTv, parseXmlTvTime, programmeHint } from "../src/epg.js";

test("EPG is remapped onto canonical JustOne tvg-id and provides logo", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="bbc1.uk"><display-name>BBC One</display-name><icon src="https://logo/bbc.png"/></channel><programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="bbc1.uk"><title>News</title></programme></tv>`);
  const channels = [{ id: "bbc-one-x", key: "bbc one", tvgId: "justone.bbc-one.x", name: "BBC One", logo: "", aliasNames: [], variants: [{ originalTvgId: "bbc1.uk" }] }];
  const xml = enrichAndBuildGuide(channels, [{ id: "guide", name: "Guide", parsed }], {});
  assert.match(xml, /channel="justone\.bbc-one\.x"/);
  assert.match(xml, /<title>News<\/title>/);
  assert.equal(channels[0].logo, "https://logo/bbc.png");
});

test("XMLTV hints expose display names and scheduled programme titles", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="ppv.42"><display-name>PPV 42</display-name><display-name>Live Events 42</display-name></channel>
    <programme start="20260914200000 +0100" stop="20260914221500 +0100" channel="ppv.42"><title>Arsenal vs Chelsea</title><sub-title>Premier League</sub-title></programme>
  </tv>`);
  const hints = epgHintsForChannelId(parsed, "ppv.42");
  assert.deepEqual(hints.displayNames, ["PPV 42", "Live Events 42"]);
  assert.equal(hints.programmes.length, 1);
  assert.equal(hints.programmes[0].title, "Arsenal vs Chelsea");
  assert.equal(hints.programmes[0].subTitle, "Premier League");
  assert.equal(hints.programmes[0].start, Date.UTC(2026, 8, 14, 19, 0, 0));
  assert.equal(hints.programmes[0].stop, Date.UTC(2026, 8, 14, 21, 15, 0));
});

test("XMLTV timestamp parser respects positive and negative offsets", () => {
  assert.equal(parseXmlTvTime("20260914200000 +0100"), Date.UTC(2026, 8, 14, 19, 0, 0));
  assert.equal(parseXmlTvTime("20260914200000 -0400"), Date.UTC(2026, 8, 15, 0, 0, 0));
});

test("programmeHint tolerates missing stop/subtitle", () => {
  const hint = programmeHint('<programme start="20260914200000 +0000" channel="x"><title>UFC 400</title></programme>');
  assert.equal(hint.title, "UFC 400");
  assert.equal(hint.subTitle, "");
  assert.equal(hint.stop, null);
});

test("generated JustOne guide is never accepted as an upstream XMLTV source", () => {
  const body = `<?xml version="1.0"?><tv generator-info-name="JustOne Catalog">
    <channel id="justone.channel.bbc-one"><display-name>BBC One UK</display-name></channel>
    <programme start="20260915070000 +0000" stop="20260915110000 +0000" channel="justone.channel.bbc-one">
      <title>Dawn Patrol</title><desc>Rise and shine with BBC One UK!</desc>
    </programme>
  </tv>`;
  assert.equal(isGeneratedJustOneGuide(body), true);
  assert.throws(() => parseXmlTv(body), /refusing generated JustOne guide as upstream XMLTV/i);
});

test("static channels without real provider EPG do not get synthetic placeholder programmes", () => {
  const channels = [{ id: "bbc-one-x", key: "bbc one", tvgId: "justone.bbc-one.x", name: "BBC One", logo: "", aliasNames: [], variants: [] }];
  const xml = enrichAndBuildGuide(channels, [], {});
  assert.doesNotMatch(xml, /<programme\b/);
  assert.doesNotMatch(xml, /Dawn Patrol|Rise and shine/i);
});