import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadataLineup } from "../src/metadata-only.js";
import { organizeLineup } from "../src/lineup.js";

const row = (id, name, group = "24/7") => ({
  name,
  tvgName: name,
  tvgId: `dlhd-${id}`,
  group,
  url: `https://resolver.vpn4u.cc/play/live/${id}.ts?key=exact-${id}`,
});

test("provider 24/7 bucket does not trap ordinary linear channels", () => {
  const raw = [
    row(1, "Fox News USA"),
    row(2, "Discovery Channel USA"),
    row(3, "TSN1 Canada"),
    row(4, "Abu Dhabi Sports 1 UAE"),
    row(5, "BNT 1 Bulgaria"),
    row(6, "Sky Sport 1 NZ"),
    row(7, "Classic Cartoons 24/7 UK"),
  ];

  const out = organizeLineup(buildMetadataLineup(raw, { iptvOrg: null }));
  const groups = Object.fromEntries(out.map((channel) => [channel.name, channel.group]));

  assert.equal(groups["Fox News"], "TV | USA");
  assert.equal(groups["Discovery Channel"], "TV | USA");
  assert.equal(groups.TSN1, "TV | Canada");
  assert.equal(groups["Abu Dhabi Sports 1 UAE"], "TV | United Arab Emirates");
  assert.equal(groups["BNT 1 Bulgaria"], "TV | Bulgaria");
  assert.equal(groups["Sky Sport 1 NZ"], "TV | New Zealand");
  assert.equal(groups["Classic Cartoons 24/7 UK"], "24/7 | UK");
});

test("strong broadcaster families fill country gaps without changing playback URLs", () => {
  const raw = [
    row(11, "Astro SuperSport 1", "Live"),
    row(12, "SuperSport Grandstand", "Live"),
    row(13, "Alkass One", "Live"),
    row(14, "SSC Sport 1", "Live"),
  ];
  const metadata = buildMetadataLineup(raw, { iptvOrg: null });
  assert.deepEqual(metadata.map((channel) => channel.country), ["MY", "ZA", "QA", "SA"]);
  assert.deepEqual(metadata.map((channel) => channel.url), raw.map((channel) => channel.url));
});
