import test from "node:test";
import assert from "node:assert/strict";
import {
  channelCoversCountry,
  channelIdentityKeys,
  countrySuffixes,
} from "../src/channel-identity.js";
import { buildMetadataLineup } from "../src/metadata-only.js";
import { organizeLineup } from "../src/lineup.js";
import { applyEpgIdentityLogos } from "../src/logo-bridge.js";
import { buildXmlTv, canonicalGuideName, matchGuideChannel } from "../src/guide.js";
import { parseXmlTv } from "../src/organizer.js";

function doc(xml, sourceUrl) {
  const parsed = parseXmlTv(xml);
  parsed.sourceUrl = sourceUrl;
  return parsed;
}

test("country suffix normalization covers Greece Denmark Cyprus and France", () => {
  assert.ok(countrySuffixes("GR").includes("greece"));
  assert.ok(countrySuffixes("DK").includes("denmark"));
  assert.ok(countrySuffixes("CY").includes("cyprus"));
  assert.ok(countrySuffixes("FR").includes("france"));
  assert.ok(channelIdentityKeys("Nova Sports Start Greece HD", "GR").includes("novasports start"));
  assert.equal(canonicalGuideName("Cytavision Sports 1 Cyprus HD", "CY"), "cytavision sports 1");
});

test("multinational IPTV-org channels can match a country-specific feed", () => {
  const eurosport = {
    id: "Eurosport1.fr",
    name: "Eurosport 1",
    country: "FR",
    broadcast_area: ["c/FR", "c/GR", "c/DK"],
  };
  assert.equal(channelCoversCountry(eurosport, "GR"), true);
  assert.equal(channelCoversCountry(eurosport, "DK"), true);
  assert.equal(channelCoversCountry(eurosport, "CY"), false);
});

test("regular regional channels get canonical IPTV identities and official logos", () => {
  const iptvOrg = {
    channels: [
      { id: "NovasportsStart.gr", name: "Novasports Start", alt_names: [], country: "GR", broadcast_area: ["c/GR"] },
      { id: "Eurosport1.fr", name: "Eurosport 1", alt_names: [], country: "FR", broadcast_area: ["c/FR", "c/GR", "c/DK"] },
      { id: "CytavisionSports1.cy", name: "Cytavision Sports 1", alt_names: [], country: "CY", broadcast_area: ["c/CY"] },
      { id: "TV2Sport.dk", name: "TV 2 Sport", alt_names: [], country: "DK", broadcast_area: ["c/DK"] },
    ],
    logos: [
      { channel: "NovasportsStart.gr", in_use: true, format: "PNG", width: 1000, tags: ["horizontal"], url: "https://logos.example/nova.png" },
      { channel: "Eurosport1.fr", in_use: true, format: "PNG", width: 1000, tags: ["horizontal"], url: "https://logos.example/eurosport.png" },
      { channel: "CytavisionSports1.cy", in_use: true, format: "PNG", width: 1000, tags: ["horizontal"], url: "https://logos.example/cyta.png" },
      { channel: "TV2Sport.dk", in_use: true, format: "PNG", width: 1000, tags: ["horizontal"], url: "https://logos.example/tv2.png" },
    ],
  };

  const rows = buildMetadataLineup([
    { name: "Nova Sports Start Greece HD", tvgName: "Nova Sports Start Greece HD", group: "Greece", url: "https://example/nova" },
    { name: "Eurosport 1 Greece", tvgName: "Eurosport 1 Greece", group: "Greece", url: "https://example/euro" },
    { name: "Cytavision Sports 1 Cyprus", tvgName: "Cytavision Sports 1 Cyprus", group: "Cyprus", url: "https://example/cyta" },
    { name: "TV 2 Sport Denmark", tvgName: "TV 2 Sport Denmark", group: "Denmark", url: "https://example/tv2" },
  ], { iptvOrg });

  const [nova, euro, cyta, tv2] = rows;
  assert.equal(nova.iptvOrgId, "NovasportsStart.gr");
  assert.equal(nova.logo, "https://logos.example/nova.png");
  assert.equal(nova.country, "GR");

  assert.equal(euro.iptvOrgId, "Eurosport1.fr");
  assert.equal(euro.logo, "https://logos.example/eurosport.png");
  assert.equal(euro.country, "GR", "multinational metadata must not move the Greek feed into France");

  assert.equal(cyta.iptvOrgId, "CytavisionSports1.cy");
  assert.equal(cyta.logo, "https://logos.example/cyta.png");
  assert.equal(cyta.country, "CY");

  assert.equal(tv2.iptvOrgId, "TV2Sport.dk");
  assert.equal(tv2.logo, "https://logos.example/tv2.png");
  assert.equal(tv2.country, "DK");
});

test("regular sports networks stay normal TV channels and lose redundant country suffixes", () => {
  const out = organizeLineup([
    { id: "nova", kind: "static", name: "Novasports Start Greece HD", country: "GR", url: "https://example/nova", logo: "https://logos.example/nova.png" },
    { id: "euro", kind: "static", name: "Eurosport 1 Denmark", country: "DK", url: "https://example/euro", logo: "https://logos.example/euro.png" },
    { id: "cyta", kind: "static", name: "Cytavision Sports 1 Cyprus", country: "CY", url: "https://example/cyta", logo: "https://logos.example/cyta.png" },
  ]);

  assert.equal(out.find((x) => x.id === "nova")?.kind, "static");
  assert.equal(out.find((x) => x.id === "nova")?.group, "TV | Greece");
  assert.equal(out.find((x) => x.id === "nova")?.name, "Novasports Start HD");
  assert.equal(out.find((x) => x.id === "euro")?.group, "TV | Denmark");
  assert.equal(out.find((x) => x.id === "euro")?.name, "Eurosport 1");
  assert.equal(out.find((x) => x.id === "cyta")?.group, "TV | Cyprus");
  assert.equal(out.find((x) => x.id === "cyta")?.name, "Cytavision Sports 1");
});

test("generated regular logos can be recovered directly from IPTV identity without an EPG hit", () => {
  const lineup = [{
    id: "nova",
    kind: "static",
    name: "Nova Sports Start",
    country: "GR",
    tvgId: "justone.nova",
    iptvOrgId: "",
    sourceTvgIds: [],
    candidates: [],
    logo: "https://resolver.example/jellyfin/artwork/channel/nova.png",
  }];
  const iptvOrg = {
    channels: [{ id: "NovasportsStart.gr", name: "Novasports Start", alt_names: [], country: "GR", broadcast_area: ["c/GR"] }],
    logos: [{ channel: "NovasportsStart.gr", in_use: true, format: "PNG", width: 1000, tags: ["horizontal"], url: "https://logos.example/nova.png" }],
  };

  const result = applyEpgIdentityLogos(lineup, [], iptvOrg);
  assert.equal(result.applied, 1);
  assert.equal(lineup[0].logo, "https://logos.example/nova.png");
  assert.equal(lineup[0].iptvOrgId, "NovasportsStart.gr");
});

test("country-specific guide packs never cross-match another country's schedule", () => {
  const now = Date.UTC(2026, 7, 31, 10, 0);
  const gr = doc(`<?xml version="1.0"?><tv>
    <channel id="Eurosport1.gr"><display-name>Eurosport 1 Greece HD</display-name></channel>
    <programme start="20260831110000 +0000" stop="20260831120000 +0000" channel="Eurosport1.gr"><title>Greek Feed Programme</title></programme>
  </tv>`, "https://epgshare01.online/epgshare01/epg_ripper_GR1.xml.gz");
  const fr = doc(`<?xml version="1.0"?><tv>
    <channel id="Eurosport1.fr"><display-name>Eurosport 1 France HD</display-name></channel>
    <programme start="20260831110000 +0000" stop="20260831120000 +0000" channel="Eurosport1.fr"><title>French Feed Programme</title></programme>
  </tv>`, "https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz");

  const channel = {
    id: "euro",
    kind: "static",
    tvgId: "Eurosport1.fr",
    iptvOrgId: "Eurosport1.fr",
    sourceTvgIds: [],
    name: "Eurosport 1",
    country: "GR",
    logo: "https://logos.example/euro.png",
  };

  assert.equal(matchGuideChannel(channel, [fr]), null, "a Greek row must not silently use the French pack");
  assert.equal(matchGuideChannel(channel, [fr, gr])?.id, "Eurosport1.gr");

  const xml = buildXmlTv([channel], [fr, gr], { now });
  assert.match(xml, /Greek Feed Programme/);
  assert.doesNotMatch(xml, /French Feed Programme/);
});
