import test from "node:test";
import assert from "node:assert/strict";
import {
  artworkPng,
  buildLineup,
  buildM3u,
  buildXmlTv,
  isAdultChannel,
  parseM3u,
  parseScheduleMetadata,
} from "../src/organizer.js";

test("parses M3U metadata", () => {
  const rows = parseM3u(`#EXTM3U\n#EXTINF:-1 tvg-id="BBCOne.uk" tvg-name="BBC One" tvg-logo="https://img/logo.png" tvg-chno="1" group-title="UK",BBC One UK\nhttps://example/live\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tvgId, "BBCOne.uk");
  assert.equal(rows[0].group, "UK");
});

test("adult content is detected", () => {
  assert.equal(isAdultChannel({ name: "18+ Example", group: "Adult" }), true);
  assert.equal(isAdultChannel({ name: "BBC One", group: "UK" }), false);
});

test("schedule time is attached to event title", () => {
  const html = `<div>Saturday 29th Aug 2026 - Schedule Time UK GMT</div><div class="card__meta">Football ⚽</div><span>14:00</span><div class="schedule__eventTitle">Chelsea vs Luton Town</div>`;
  const meta = parseScheduleMetadata(html);
  const row = meta.byEvent.get("chelsea vs luton town");
  assert.ok(row);
  assert.equal(row.group, "Football ⚽");
  assert.ok(row.start > Date.UTC(2026, 7, 29, 12, 0));
});

test("duplicate event sources become one sports programme", () => {
  const rows = [
    { name: "Chelsea vs Luton Town — Sky Sports Football UK", group: "Football", url: "https://a" },
    { name: "Chelsea vs Luton Town — Backup Stream", group: "Football", url: "https://b" },
    { name: "BBC One UK", tvgId: "BBCOne.uk", group: "UK", url: "https://c" },
    { name: "18+ Hidden", group: "18+", url: "https://d" },
  ];
  const schedule = { byEvent: new Map([["chelsea vs luton town", { title: "Chelsea vs Luton Town", group: "Football", start: Date.now(), upcoming: false }]]) };
  const lineup = buildLineup(rows, { schedule });
  const sports = lineup.filter((x) => x.kind === "sport-slot");
  assert.equal(sports.length, 1);
  assert.equal(sports[0].programmes[0].candidates.length, 2);
  assert.equal(lineup.some((x) => /18\+/.test(x.name)), false);
});

test("IPTV metadata matching tolerates provider-style ids and punctuation", () => {
  const iptvOrg = {
    channels: [
      { id: "ITV1.uk", name: "ITV1", alt_names: ["ITV 1"], country: "GB", is_nsfw: false },
      { id: "RTP3.pt", name: "RTP 3", alt_names: [], country: "PT", is_nsfw: false },
      { id: "AandE.us", name: "A&E", alt_names: ["A and E"], country: "US", is_nsfw: false },
    ],
    logos: [
      { channel: "ITV1.uk", url: "https://logos.example/itv1.png", format: "PNG", width: 800, tags: ["horizontal"] },
      { channel: "RTP3.pt", url: "https://logos.example/rtp3.png", format: "PNG", width: 800, tags: ["horizontal"] },
      { channel: "AandE.us", url: "https://logos.example/ae.png", format: "PNG", width: 800, tags: ["horizontal"] },
    ],
  };

  const lineup = buildLineup([
    { name: "ITV 1 UK", tvgId: "ITV1.HD.uk", group: "UK", url: "https://itv" },
    { name: "RTP 3 Portugal", tvgId: "RTP.3.HD.pt", group: "Portugal", url: "https://rtp" },
    { name: "A&E USA", tvgId: "A.and.E.HD.us2", group: "USA", url: "https://ae" },
  ], { iptvOrg });

  const byName = new Map(lineup.filter((x) => x.kind === "static").map((x) => [x.name, x]));
  assert.equal(byName.get("ITV 1 UK")?.iptvOrgId, "ITV1.uk");
  assert.equal(byName.get("ITV 1 UK")?.logo, "https://logos.example/itv1.png");
  assert.equal(byName.get("RTP 3 Portugal")?.iptvOrgId, "RTP3.pt");
  assert.equal(byName.get("RTP 3 Portugal")?.logo, "https://logos.example/rtp3.png");
  assert.equal(byName.get("A&E USA")?.iptvOrgId, "AandE.us");
  assert.equal(byName.get("A&E USA")?.logo, "https://logos.example/ae.png");
});

test("ambiguous metadata names are not guessed across a country", () => {
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

  const [channel] = buildLineup([
    { name: "Example USA", group: "USA", url: "https://example" },
  ], { iptvOrg }).filter((x) => x.kind === "static");

  assert.equal(channel.iptvOrgId, "");
  assert.match(channel.logo, /\/jellyfin\/artwork\/channel\//);
});

test("Jellyfin M3U and XMLTV use matching ids and programme icons", () => {
  const lineup = buildLineup([{ name: "BBC One UK", tvgId: "BBCOne.uk", group: "UK", url: "https://c" }]);
  const m3u = buildM3u(lineup);
  const guide = buildXmlTv(lineup, []);
  assert.match(m3u, /tvg-id="BBCOne.uk"/);
  assert.match(guide, /<channel id="BBCOne.uk">/);
  assert.match(guide, /<programme /);
  assert.match(guide, /<icon src=/);
});

test("generated artwork is a valid PNG", () => {
  const png = artworkPng("football-test", "program");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(png.length > 100);
});
