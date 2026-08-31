import test from "node:test";
import assert from "node:assert/strict";
import { artworkPng } from "../src/artwork.js";
import { buildXmlTv, EPG_HORIZON_HOURS, parseXmltvTime, programmeInWindow } from "../src/guide.js";
import { buildMetadataM3u } from "../src/metadata-only.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

function xmltv(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

function programme(channel, start, stop, title) {
  return `<programme start="${xmltv(start)}" stop="${xmltv(stop)}" channel="${channel}"><title>${title}</title></programme>`;
}

test("EPG horizon is exactly 24 hours by default", () => {
  assert.equal(EPG_HORIZON_HOURS, 24);
  assert.equal(parseXmltvTime("20260831120000 +0000"), NOW);
  assert.equal(programmeInWindow(programme("bbc", NOW + HOUR, NOW + 2 * HOUR, "inside"), NOW), true);
  assert.equal(programmeInWindow(programme("bbc", NOW + 25 * HOUR, NOW + 26 * HOUR, "outside"), NOW), false);
});

test("final XMLTV excludes upstream programmes beyond 24h and upstream-only channels", () => {
  const channel = {
    id: "channel.bbc",
    tvgId: "BBCOne.uk",
    name: "BBC One",
    country: "GB",
    kind: "static",
    logo: "https://example.test/bbc.png",
    candidates: [{ url: "https://resolver.vpn4u.cc/play/live/1.ts", label: "BBC One UK" }],
    sourceTvgIds: ["BBCOne.uk"],
    programmes: [],
    url: "https://resolver.vpn4u.cc/play/live/1.ts",
  };
  const doc = {
    sourceUrl: "https://example.test/epg_ripper_UK1.xml",
    channels: new Map([
      ["BBCOne.uk", { id: "BBCOne.uk", display: ["BBC One"], icon: "https://example.test/bbc.png" }],
      ["Unused.uk", { id: "Unused.uk", display: ["Unused Channel"], icon: "" }],
    ]),
    programmes: new Map([
      ["BBCOne.uk", [
        programme("BBCOne.uk", NOW - HOUR, NOW + HOUR, "Current Programme"),
        programme("BBCOne.uk", NOW + 2 * HOUR, NOW + 3 * HOUR, "Tonight Programme"),
        programme("BBCOne.uk", NOW + 30 * HOUR, NOW + 31 * HOUR, "Tomorrow Too Late"),
      ]],
      ["Unused.uk", [programme("Unused.uk", NOW + HOUR, NOW + 2 * HOUR, "Should Never Appear")]],
    ]),
  };

  const xml = buildXmlTv([channel], [doc], { now: NOW });
  assert.match(xml, /<channel id="BBCOne\.uk">/);
  assert.match(xml, /Current Programme/);
  assert.match(xml, /Tonight Programme/);
  assert.doesNotMatch(xml, /Tomorrow Too Late/);
  assert.doesNotMatch(xml, /Unused\.uk/);
  assert.doesNotMatch(xml, /Should Never Appear/);
});

test("sports event programmes are pruned to the same 24h horizon", () => {
  const event = {
    id: "event.match",
    tvgId: "justone.event.match",
    name: "ATP - Singles: Stefan Gorzny vs Raphael Collignon",
    group: "Sports | Tennis",
    kind: "sport-slot",
    eventFailover: true,
    logo: "https://resolver.vpn4u.cc/jellyfin/artwork/channel/event.match.png",
    url: "https://resolver.vpn4u.cc/jellyfin/event/event.match.ts",
    programmes: [
      { start: NOW + HOUR, end: NOW + 3 * HOUR, title: "ATP - Singles: Stefan Gorzny vs Raphael Collignon", categories: ["Sports", "Tennis"], scheduleSource: "dlstreams" },
      { start: NOW + 28 * HOUR, end: NOW + 30 * HOUR, title: "Far Future Match", categories: ["Sports", "Tennis"], scheduleSource: "dlstreams" },
    ],
  };
  const xml = buildXmlTv([event], [], { now: NOW });
  assert.match(xml, /Stefan Gorzny vs Raphael Collignon/);
  assert.doesNotMatch(xml, /Far Future Match/);
});

test("M3U tvg ids and XMLTV channel ids stay in lockstep", () => {
  const lineup = [
    {
      id: "event.match",
      tvgId: "justone.event.match",
      name: "Arsenal vs Chelsea",
      group: "Sports | Football",
      number: 1,
      kind: "sport-slot",
      eventFailover: true,
      logo: "https://resolver.vpn4u.cc/jellyfin/artwork/channel/event.match.png",
      url: "https://resolver.vpn4u.cc/jellyfin/event/event.match.ts",
      programmes: [{ start: NOW + HOUR, end: NOW + 3 * HOUR, title: "Arsenal vs Chelsea", categories: ["Sports", "Football"], scheduleSource: "dlstreams" }],
    },
    {
      id: "channel.sky",
      tvgId: "SkySportsMainEvent.uk",
      name: "Sky Sports Main Event",
      group: "TV | UK",
      number: 2001,
      country: "GB",
      kind: "static",
      logo: "https://example.test/sky.png",
      url: "https://resolver.vpn4u.cc/play/live/2.ts",
      programmes: [],
      candidates: [{ url: "https://resolver.vpn4u.cc/play/live/2.ts", label: "Sky Sports Main Event" }],
    },
  ];

  const m3u = buildMetadataM3u(lineup);
  const xml = buildXmlTv(lineup, [], { now: NOW });
  const m3uIds = [...m3u.matchAll(/tvg-id="([^"]+)"/g)].map((m) => m[1]).sort();
  const xmlIds = [...xml.matchAll(/<channel id="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(xmlIds, m3uIds);
});

test("event square logo uses event context while normal generated tile remains generic", () => {
  const eventContext = {
    kind: "channel",
    title: "ATP - Singles: Stefan Gorzny vs Raphael Collignon",
    sport: "Sports | Tennis",
    channel: { kind: "sport-slot", eventFailover: true },
  };
  const normalContext = {
    kind: "channel",
    title: "Abu Dhabi Sports 1 Premium",
    sport: "TV | AE",
    channel: { kind: "static" },
  };
  const eventPng = artworkPng("event-test", "channel", eventContext);
  const normalPng = artworkPng("event-test", "channel", normalContext);
  assert.deepEqual([...eventPng.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.deepEqual([...normalPng.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.notDeepEqual(eventPng, normalPng);
});
