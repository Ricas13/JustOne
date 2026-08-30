import test from "node:test";
import assert from "node:assert/strict";
import { chooseChannelLogo, isGeneratedChannelLogo } from "../src/channel-logos.js";
import { guideCoverage } from "../src/guide.js";
import { parseXmlTv } from "../src/organizer.js";

test("real existing channel logos are never replaced by guide artwork", () => {
  const result = chooseChannelLogo("https://playlist.example/logo.png", "https://guide.example/logo.png");
  assert.equal(result.logo, "https://playlist.example/logo.png");
  assert.equal(result.source, "existing");
  assert.equal(result.changed, false);
});

test("generated channel artwork is replaced by a usable guide logo", () => {
  const result = chooseChannelLogo(
    "https://resolver.example/jellyfin/artwork/channel/channel.abc.png",
    "https://guide.example/bbc-one.png",
  );
  assert.equal(result.logo, "https://guide.example/bbc-one.png");
  assert.equal(result.source, "epg");
  assert.equal(result.changed, true);
});

test("guide coverage feeds matched XMLTV logos back into the tuner lineup", () => {
  const xml = `<?xml version="1.0"?><tv>
    <channel id="BBC.One.HD.uk">
      <display-name>BBC One HD</display-name>
      <icon src="https://guide.example/bbc-one.png" />
    </channel>
    <programme start="20260830110000 +0000" stop="20260830120000 +0000" channel="BBC.One.HD.uk"><title>BBC News</title></programme>
  </tv>`;
  const doc = parseXmlTv(xml);
  doc.sourceUrl = "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz";
  const lineup = [{
    id: "channel.bbc",
    kind: "static",
    name: "BBC One UK",
    country: "GB",
    tvgId: "justone.channel.bbc",
    logo: "https://resolver.example/jellyfin/artwork/channel/channel.bbc.png",
    candidates: [],
  }];

  const stats = guideCoverage(lineup, [doc]);
  assert.equal(lineup[0].logo, "https://guide.example/bbc-one.png");
  assert.equal(lineup[0].logoSource, "epg");
  assert.equal(stats.guideLogosApplied, 1);
  assert.equal(stats.generatedLogosRemaining, 0);
  assert.equal(stats.channelsWithPrograms, 1);
});

test("missing guide artwork leaves the generated fallback in place", () => {
  assert.equal(isGeneratedChannelLogo(""), true);
  const result = chooseChannelLogo("https://resolver.example/jellyfin/artwork/channel/a.png", "");
  assert.equal(result.source, "generated");
  assert.equal(result.changed, false);
});
