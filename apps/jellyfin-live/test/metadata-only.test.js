import assert from "node:assert/strict";
import test from "node:test";
import { filterJellyfinRows } from "../src/filter.js";
import { organizeLineup } from "../src/lineup.js";
import { buildMetadataLineup, buildMetadataM3u } from "../src/metadata-only.js";

function streamLines(m3u) {
  return String(m3u)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
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

test("full Jellyfin beautifier may reorder metadata but cannot alter any accepted stream URL", () => {
  const raw = [
    { name: "BBC One UK", tvgId: "dlhd-101", group: "UK", url: "https://resolver.vpn4u.cc/play/live/101.ts?key=x&sig=a%2Fb" },
    { name: "ESPN USA", tvgId: "dlhd-102", group: "USA", url: "https://resolver.vpn4u.cc/play/live/102.ts?key=x&sig=c%3Dd" },
    { name: "RTP 1 Portugal", tvgId: "dlhd-103", group: "Portugal", url: "https://resolver.vpn4u.cc/play/live/103.ts?key=x&sig=e%26f" },
    { name: "Chelsea vs Arsenal - Sky Sports Football UK", tvgId: "dlhd-104", group: "Football", url: "https://resolver.vpn4u.cc/play/live/104.ts?key=x&event=chelsea%20arsenal" },
    { name: "18+ Example", tvgId: "adult-1", group: "18+", url: "https://resolver.vpn4u.cc/play/live/900.ts?key=x" },
    { name: "Pluto TV Action", tvgId: "pluto-1", group: "Free Channels", url: "https://example.invalid/pluto.m3u8" },
    { name: "IPTV Org Example", tvgId: "iptv-org-1", group: "IPTV-Org", url: "https://iptv-org.github.io/example.m3u" },
  ];

  const acceptedRaw = filterJellyfinRows(raw);
  const enhanced = organizeLineup(buildMetadataLineup(acceptedRaw, { iptvOrg: null, excludeAdult: true }));
  const outputUrls = streamLines(buildMetadataM3u(enhanced));

  assert.deepEqual(
    sorted(outputUrls),
    sorted(acceptedRaw.map((row) => row.url)),
    "enhanced output must contain exactly the accepted raw URLs, regardless of metadata reordering",
  );
  assert.equal(new Set(outputUrls).size, outputUrls.length, "beautifier must not invent duplicate playback rows");
  for (const url of outputUrls) {
    assert.match(url, /^https:\/\/resolver\.vpn4u\.cc\/play\/live\//);
  }
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
