import test from "node:test";
import assert from "node:assert/strict";
import { channelIdentityKeys } from "../src/channel-identity.js";
import { matchGuideChannel } from "../src/guide.js";
import { applyEpgIdentityLogos } from "../src/logo-bridge.js";
import { parseXmlTv } from "../src/organizer.js";

function doc(xml, sourceUrl) {
  const parsed = parseXmlTv(xml);
  parsed.sourceUrl = sourceUrl;
  return parsed;
}

const ukDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="SkySp.Fball.HD.uk"><display-name>Sky Sports Football HD</display-name></channel>
  <channel id="SkySp.Golf.HD.uk"><display-name>Sky Sports Golf HD</display-name></channel>
  <channel id="SkySp.Main.Ev.HD.uk"><display-name>Sky Sports Main Event HD</display-name></channel>
  <channel id="SkySp.Mix.HD.uk"><display-name>Sky Sports Mix HD</display-name></channel>
  <channel id="SkySp.Prem.League.HD.uk"><display-name>Sky Sports PL HD</display-name></channel>
  <channel id="SkySp.Tennis.HD.uk"><display-name>Sky Sports Tennis HD</display-name></channel>
  <channel id="BT.Sport.1.HD.uk"><display-name>BT Sport 1 HD</display-name></channel>
  <channel id="BT.Sport.3.HD.uk"><display-name>BT Sport 3 HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Fball.HD.uk"><title>Football</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Golf.HD.uk"><title>Golf</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Main.Ev.HD.uk"><title>Main Event</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Mix.HD.uk"><title>Mix</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Prem.League.HD.uk"><title>Premier League</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SkySp.Tennis.HD.uk"><title>Tennis</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="BT.Sport.1.HD.uk"><title>TNT One</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="BT.Sport.3.HD.uk"><title>TNT Three</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");

const ptDoc = doc(`<?xml version="1.0"?><tv>
  <channel id="SportTV2.HD.pt"><display-name>SportTV2 HD</display-name></channel>
  <channel id="BTV.HD.pt"><display-name>BTV HD</display-name></channel>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="SportTV2.HD.pt"><title>Sport TV</title></programme>
  <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="BTV.HD.pt"><title>Benfica TV</title></programme>
</tv>`, "https://epgshare01.online/epgshare01/epg_ripper_PT1.xml.gz");

test("shared sports identity keys normalize provider abbreviations and country-scoped rebrands", () => {
  assert.ok(channelIdentityKeys("SkySp Fball UK HD", "GB").includes("sky sports football"));
  assert.ok(channelIdentityKeys("Sky Sports PL UK", "GB").includes("sky sports premier league"));
  assert.ok(channelIdentityKeys("TNT Sports 3 UK", "GB").includes("bt sport 3"));
  assert.ok(channelIdentityKeys("SportTV2 Portugal HD", "PT").includes("sport tv 2"));
  assert.ok(channelIdentityKeys("Benfica TV Portugal", "PT").includes("btv"));
  assert.ok(channelIdentityKeys("BTV Portugal", "PT").includes("benfica tv"));
});

test("guide matcher resolves the main missing UK sports channels", () => {
  const cases = [
    ["Sky Sports Football UK", "SkySp.Fball.HD.uk"],
    ["Sky Sports Golf UK", "SkySp.Golf.HD.uk"],
    ["Sky Sports Main Event UK", "SkySp.Main.Ev.HD.uk"],
    ["Sky Sports Mix UK", "SkySp.Mix.HD.uk"],
    ["Sky Sports Premier League UK", "SkySp.Prem.League.HD.uk"],
    ["Sky Sports Tennis UK", "SkySp.Tennis.HD.uk"],
    ["TNT Sports 1 UK", "BT.Sport.1.HD.uk"],
    ["TNT Sports 3 UK", "BT.Sport.3.HD.uk"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(matchGuideChannel({ name, country: "GB" }, [ukDoc])?.id, expected, name);
  }
});

test("guide matcher resolves Sport TV 2 and Benfica TV through provider naming differences", () => {
  assert.equal(matchGuideChannel({ name: "Sport TV 2 Portugal", country: "PT" }, [ptDoc])?.id, "SportTV2.HD.pt");
  assert.equal(matchGuideChannel({ name: "Benfica TV Portugal", country: "PT" }, [ptDoc])?.id, "BTV.HD.pt");
});

test("numbered sports aliases never cross-wire neighbouring channels", () => {
  const onlyThree = doc(`<?xml version="1.0"?><tv>
    <channel id="BT.Sport.3.HD.uk"><display-name>BT Sport 3 HD</display-name></channel>
    <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="BT.Sport.3.HD.uk"><title>Three</title></programme>
  </tv>`, "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz");
  assert.equal(matchGuideChannel({ name: "TNT Sports 1 UK", country: "GB" }, [onlyThree]), null);
});

test("IPTV-org logo recovery uses the same Benfica/BTV identity vocabulary", () => {
  const lineup = [{
    id: "channel.benfica",
    kind: "static",
    name: "Benfica TV Portugal",
    country: "PT",
    tvgId: "justone.channel.benfica",
    logo: "https://resolver.example/jellyfin/artwork/channel/channel.benfica.png",
    candidates: [],
  }];
  const iptvOrg = {
    channels: [{ id: "BTV.pt", name: "BTV", alt_names: [], country: "PT", is_nsfw: false }],
    logos: [{ channel: "BTV.pt", url: "https://logos.example/btv.png", format: "PNG", width: 800, tags: ["horizontal"] }],
  };
  const stats = applyEpgIdentityLogos(lineup, [ptDoc], iptvOrg);
  assert.equal(stats.applied, 1);
  assert.equal(lineup[0].logo, "https://logos.example/btv.png");
});
