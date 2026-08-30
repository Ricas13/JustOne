import assert from "node:assert/strict";
import test from "node:test";
import { buildMetadataLineup, buildMetadataM3u } from "../src/metadata-only.js";

function streamLines(m3u) {
  return String(m3u)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

test("metadata decoration preserves every raw playback URL byte-for-byte", () => {
  const raw = [
    {
      name: "BBC One UK",
      tvgName: "BBC One UK",
      tvgId: "dlhd-501",
      group: "UK",
      number: 1,
      logo: "",
      url: "https://resolver.vpn4u.cc/play/live/501.ts?key=secret&token=a%2Fb%3Dc",
    },
    {
      name: "BBC One UK Backup",
      tvgName: "BBC One UK",
      tvgId: "dlhd-502",
      group: "UK",
      number: 2,
      logo: "https://logos.example/bbc.png",
      url: "https://resolver.vpn4u.cc/play/live/502.ts?key=secret&source=backup",
    },
  ];

  const lineup = buildMetadataLineup(raw, { iptvOrg: null, excludeAdult: true });
  assert.equal(lineup.length, 2, "duplicate-looking channels must not be collapsed");
  assert.deepEqual(lineup.map((row) => row.url), raw.map((row) => row.url));

  const m3u = buildMetadataM3u(lineup);
  assert.deepEqual(streamLines(m3u), raw.map((row) => row.url));
  assert.doesNotMatch(m3u, /\/jellyfin\/play\//);
});

test("metadata layer filters adult rows when configured without rewriting accepted streams", () => {
  const raw = [
    {
      name: "News Channel",
      tvgName: "News Channel",
      tvgId: "news.example",
      group: "USA",
      number: 10,
      logo: "",
      url: "https://resolver.vpn4u.cc/play/live/700.ts?key=keep-this-exactly",
    },
    {
      name: "Adult 18+",
      tvgName: "Adult 18+",
      tvgId: "adult.example",
      group: "18+",
      number: 11,
      logo: "",
      url: "https://resolver.vpn4u.cc/play/live/701.ts?key=also-secret",
    },
    {
      name: "Babestation",
      tvgName: "Babestation",
      tvgId: "adult.babestation",
      group: "UK",
      number: 12,
      logo: "",
      url: "https://resolver.vpn4u.cc/play/live/702.ts?key=adult-secret",
    },
  ];

  const lineup = buildMetadataLineup(raw, { iptvOrg: null, excludeAdult: true });
  assert.equal(lineup.length, 1);
  assert.equal(lineup[0].url, raw[0].url);
  assert.deepEqual(streamLines(buildMetadataM3u(lineup)), [raw[0].url]);
});

test("adult filtering can be disabled without another layer silently deleting rows", () => {
  const raw = [{
    name: "18+ Example",
    tvgName: "18+ Example",
    tvgId: "adult.example",
    group: "Adult",
    url: "https://resolver.vpn4u.cc/play/live/999.ts?token=exact",
  }];

  const lineup = buildMetadataLineup(raw, { iptvOrg: null, excludeAdult: false });
  assert.equal(lineup.length, 1);
  assert.equal(lineup[0].url, raw[0].url);
});

test("IPTV metadata enrichment changes metadata only", () => {
  const url = "https://resolver.vpn4u.cc/play/live/800.ts?key=signed-value";
  const lineup = buildMetadataLineup(
    [
      {
        name: "RTP 3 Portugal",
        tvgName: "RTP 3 Portugal",
        tvgId: "RTP3.pt",
        group: "Portugal",
        number: 20,
        logo: "",
        url,
      },
    ],
    {
      excludeAdult: true,
      iptvOrg: {
        channels: [{ id: "RTP3.pt", name: "RTP 3", alt_names: [], country: "PT", is_nsfw: false }],
        logos: [{ channel: "RTP3.pt", url: "https://logos.example/rtp3.png", width: 800, tags: ["horizontal"] }],
      },
    },
  );

  assert.equal(lineup.length, 1);
  assert.equal(lineup[0].iptvOrgId, "RTP3.pt");
  assert.equal(lineup[0].logo, "https://logos.example/rtp3.png");
  assert.equal(lineup[0].url, url);
  assert.equal(streamLines(buildMetadataM3u(lineup))[0], url);
});
