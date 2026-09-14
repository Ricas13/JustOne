import test from "node:test";
import assert from "node:assert/strict";
import { enrichAndBuildGuide, parseXmlTv } from "../src/epg.js";

test("EPG is remapped onto canonical JustOne tvg-id and provides logo", () => {
  const parsed = parseXmlTv(`<?xml version="1.0"?><tv><channel id="bbc1.uk"><display-name>BBC One</display-name><icon src="https://logo/bbc.png"/></channel><programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="bbc1.uk"><title>News</title></programme></tv>`);
  const channels = [{ id: "bbc-one-x", key: "bbc one", tvgId: "justone.bbc-one.x", name: "BBC One", logo: "", aliasNames: [], variants: [{ originalTvgId: "bbc1.uk" }] }];
  const xml = enrichAndBuildGuide(channels, [{ id: "guide", name: "Guide", parsed }], {});
  assert.match(xml, /channel="justone\.bbc-one\.x"/);
  assert.equal(channels[0].logo, "https://logo/bbc.png");
});
