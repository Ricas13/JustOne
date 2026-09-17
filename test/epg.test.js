import test from "node:test";
import assert from "node:assert/strict";
import { enrichAndBuildGuide, epgHintsForChannelId, isGeneratedJustOneGuide, parseXmlTv, parseXmlTvTime, programmeHint } from "../src/epg.js";

test("EPG is remapped onto canonical JustOne tvg-id and provides logo", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="bbc1.uk"><display-name>BBC One</display-name><icon src="https://logo/bbc.png"/></channel><programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="bbc1.uk"><title>News</title></programme></tv>`);
  const channels = [{ id: "bbc-one-x", key: "bbc one", tvgId: "justone.bbc-one.x", name: "BBC One", logo: "", aliasNames: [], variants: [{ originalTvgId: "bbc1.uk" }] }];
  const xml = enrichAndBuildGuide(channels, [{ id: "guide", name: "Guide", parsed }], {});
  assert.match(xml, /channel="justone\.bbc-one\.x"/);
  assert.match(xml, /<title>News<\/title>/);
  assert.match(xml, /<icon src="https:\/\/logo\/bbc\.png" \/>/);
  assert.match(xml, /<image type="backdrop" size="3" orient="L">https:\/\/logo\/bbc\.png<\/image>/);
  assert.equal(channels[0].logo, "https://logo/bbc.png");
});

test("static programme artwork from provider XMLTV is preserved and promoted to Jellyfin backdrop", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="film.uk"><display-name>Film Channel</display-name><icon src="https://logo/film.png"/></channel>
    <programme start="20260101000000 +0000" stop="20260101020000 +0000" channel="film.uk"><title>The Film</title><icon src="https://art.example/the-film.jpg"/></programme>
  </tv>`);
  const channels = [{ id: "film-x", key: "film", tvgId: "justone.film.x", name: "Film Channel", logo: "", aliasNames: [], variants: [{ originalTvgId: "film.uk" }] }];
  const xml = enrichAndBuildGuide(channels, [{ id: "guide", name: "Guide", parsed }], {});
  assert.match(xml, /<icon src="https:\/\/art\.example\/the-film\.jpg"\/>/);
  assert.match(xml, /<image type="backdrop" size="3" orient="L">https:\/\/art\.example\/the-film\.jpg<\/image>/);
  assert.doesNotMatch(xml, /<image[^>]*>https:\/\/logo\/film\.png<\/image>/);
});

test("existing provider programme image is not duplicated or replaced", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="five.uk"><display-name>5 USA</display-name><icon src="https://logo/5usa.png"/></channel>
    <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="five.uk"><title>Movie</title><image type="backdrop" size="3" orient="L">https://art.example/movie.jpg</image></programme>
  </tv>`);
  const channels = [{ id: "five-x", key: "5 usa", tvgId: "justone.five.x", name: "5 USA", logo: "", aliasNames: [], variants: [{ originalTvgId: "five.uk" }] }];
  const xml = enrichAndBuildGuide(channels, [{ id: "guide", name: "Guide", parsed }], {});
  assert.equal((xml.match(/https:\/\/art\.example\/movie\.jpg/g) || []).length, 1);
  assert.doesNotMatch(xml, /<image[^>]*>https:\/\/logo\/5usa\.png<\/image>/);
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

test("DLHD channel logo remains authoritative over XMLTV and provider logos", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="canal.fr"><display-name>Canal+ Foot France</display-name><icon src="https://xmltv/logo.png"/></channel>
  </tv>`);
  const channels = [{
    id:"canal", key:"canal", tvgId:"justone.canal", name:"Canal+ Foot France",
    logo:"https://dlhd/logo.png", aliasNames:[], dlhdRefId:"channel-canal",
    variants:[{ originalTvgId:"canal.fr", logo:"https://provider/logo.png" }],
  }];
  enrichAndBuildGuide(channels, [{ id:"guide", name:"Guide", parsed }], {});
  assert.equal(channels[0].logo, "https://dlhd/logo.png");
});

test("DLHD events on normal channels fill XMLTV gaps but never duplicate an existing programme slot", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="sky.uk"><display-name>Sky Sports Football UK</display-name></channel>
    <programme start="20260918180000 +0000" stop="20260918200000 +0000" channel="sky.uk"><title>Existing Match</title></programme>
  </tv>`);
  const channels = [{
    id:"sky", key:"sky", tvgId:"justone.sky", name:"Sky Sports Football UK",
    logo:"https://dlhd/sky.png", aliasNames:[], dlhdRefId:"channel-sky",
    referenceKind:"channel", variants:[{ originalTvgId:"sky.uk" }],
  }];
  const dlhdReference = {
    linearEvents: [
      {
        id:"covered", name:"Arsenal vs Chelsea", category:"Football",
        start:Date.UTC(2026,8,18,18,30), end:Date.UTC(2026,8,18,19,30),
        linkedStaticChannels:[{ id:"channel-sky" }],
      },
      {
        id:"gap", name:"Benfica vs Porto", category:"Football",
        start:Date.UTC(2026,8,18,20,30), end:Date.UTC(2026,8,18,22,30),
        linkedStaticChannels:[{ id:"channel-sky" }],
      },
    ],
  };
  const xml = enrichAndBuildGuide(channels, [{ id:"guide", name:"Guide", parsed }], {}, { dlhdReference });
  assert.match(xml, /<title>Existing Match<\/title>/);
  assert.doesNotMatch(xml, /<title>Arsenal vs Chelsea<\/title>/);
  assert.match(xml, /<title>Benfica vs Porto<\/title>/);
  assert.equal((xml.match(/channel="justone\.sky"/g) || []).length, 2);
});
