import test from "node:test";
import assert from "node:assert/strict";
import { applyEpgIdentityLogos } from "../src/logo-bridge.js";
import { parseXmlTv } from "../src/organizer.js";

test("EPG identity recovers an IPTV logo when XMLTV itself has no icon", () => {
  const doc = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="ITV1.HD.uk"><display-name>ITV 1 HD</display-name></channel>
    <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="ITV1.HD.uk"><title>Programme</title></programme>
  </tv>`);
  doc.sourceUrl = "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz";

  const lineup = [{
    id: "channel.itv",
    kind: "static",
    name: "ITV 1 UK",
    country: "GB",
    tvgId: "justone.channel.itv",
    logo: "https://resolver.example/jellyfin/artwork/channel/channel.itv.png",
    candidates: [],
  }];
  const iptvOrg = {
    channels: [{ id: "ITV1.uk", name: "ITV1", alt_names: ["ITV 1"], country: "GB", is_nsfw: false }],
    logos: [{ channel: "ITV1.uk", url: "https://logos.example/itv1.png", format: "PNG", width: 800, tags: ["horizontal"] }],
  };

  const stats = applyEpgIdentityLogos(lineup, [doc], iptvOrg);
  assert.equal(stats.applied, 1);
  assert.equal(lineup[0].logo, "https://logos.example/itv1.png");
  assert.equal(lineup[0].logoSource, "iptv-epg-identity");
});

test("EPG identity bridge refuses ambiguous IPTV identities", () => {
  const doc = parseXmlTv(`<?xml version="1.0"?><tv>
    <channel id="Example.HD.us"><display-name>Example HD</display-name></channel>
    <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="Example.HD.us"><title>Programme</title></programme>
  </tv>`);
  doc.sourceUrl = "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz";

  const lineup = [{
    id: "channel.example",
    kind: "static",
    name: "Example USA",
    country: "US",
    tvgId: "justone.channel.example",
    logo: "https://resolver.example/jellyfin/artwork/channel/channel.example.png",
    candidates: [],
  }];
  const iptvOrg = {
    channels: [
      { id: "ExampleEast.us", name: "Example", alt_names: [], country: "US", is_nsfw: false },
      { id: "ExampleWest.us", name: "Example", alt_names: [], country: "US", is_nsfw: false },
    ],
    logos: [
      { channel: "ExampleEast.us", url: "https://logos.example/east.png", format: "PNG" },
      { channel: "ExampleWest.us", url: "https://logos.example/west.png", format: "PNG" },
    ],
  };

  const stats = applyEpgIdentityLogos(lineup, [doc], iptvOrg);
  assert.equal(stats.applied, 0);
  assert.match(lineup[0].logo, /\/jellyfin\/artwork\/channel\//);
});
