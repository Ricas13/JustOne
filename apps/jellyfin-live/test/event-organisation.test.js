import test from "node:test";
import assert from "node:assert/strict";
import { organizeLineup } from "../src/lineup.js";

const url = (id) => `https://resolver.example/play/live/${id}.ts?key=exact-${id}`;

test("event rows do not leak into country TV groups", () => {
  const input = [
    { id: "bbc", kind: "static", name: "BBC One UK", country: "GB", group: "UK", url: url("bbc") },
    { id: "league-one", kind: "static", name: "England - League One : AFC Wimbledon vs Wigan Athletic - Sky Sports+", country: "GB", group: "UK", url: url("league-one") },
    { id: "afl", kind: "static", name: "AFL Women : Collingwood Magpies W vs Hawthorn Hawks W - TNT Sports 1", country: "GB", group: "UK", url: url("afl") },
    { id: "f1", kind: "static", name: "Formula 1 Gran Premio de España | Madrid, Spain | 11 - 13 September 2026 - Sky Sports F1", country: "GB", group: "UK", url: url("f1") },
    { id: "rtp", kind: "static", name: "RTP 2 Portugal", country: "PT", group: "Portugal", url: url("rtp") },
    { id: "canoe", kind: "static", name: "ICF Canoe Slalom World Championships - Poznań 2026 : Day 5 Session 1 - RTP 2", country: "PT", group: "Portugal", url: url("canoe") },
    { id: "surf", kind: "static", name: "WSL Tour Surf : Patin Classic Galicia Pro QS 6000 - World Surf League - Sport TV6", country: "PT", group: "Portugal", url: url("surf") },
  ];

  const out = organizeLineup(input);
  const byId = new Map(out.map((row) => [row.id, row]));

  assert.equal(byId.get("bbc").group, "TV | UK");
  assert.equal(byId.get("rtp").group, "TV | Portugal");

  for (const id of ["league-one", "afl", "f1", "canoe", "surf"]) {
    assert.match(byId.get(id).group, /^Sports \| /, id);
    assert.equal(byId.get(id).kind, "sport-slot", id);
  }

  assert.equal(byId.get("league-one").group, "Sports | Football");
  assert.equal(byId.get("f1").group, "Sports | Motorsport");
});

test("real linear sports networks remain country channels", () => {
  const input = [
    { id: "sky", kind: "static", name: "Sky Sports F1 UK", country: "GB", group: "UK", url: url("sky") },
    { id: "tnt", kind: "static", name: "TNT Sports 1 UK", country: "GB", group: "UK", url: url("tnt") },
    { id: "espn", kind: "static", name: "ESPN USA", country: "US", group: "USA", url: url("espn") },
    { id: "sporttv", kind: "static", name: "Sport TV6 Portugal", country: "PT", group: "Portugal", url: url("sporttv") },
    { id: "dazn", kind: "static", name: "DAZN 1 Portugal", country: "PT", group: "Portugal", url: url("dazn") },
  ];

  const out = organizeLineup(input);
  const byId = new Map(out.map((row) => [row.id, row]));
  assert.equal(byId.get("sky").group, "TV | UK");
  assert.equal(byId.get("tnt").group, "TV | UK");
  assert.equal(byId.get("espn").group, "TV | USA");
  assert.equal(byId.get("sporttv").group, "TV | Portugal");
  assert.equal(byId.get("dazn").group, "TV | Portugal");
});

test("moving events changes metadata only and preserves every URL", () => {
  const input = [
    { id: "a", kind: "static", name: "Chelsea vs Arsenal - Sky Sports Football UK", country: "GB", group: "UK", url: url("a") },
    { id: "b", kind: "static", name: "BBC One UK", country: "GB", group: "UK", url: url("b") },
    { id: "c", kind: "static", name: "RTP 1 Portugal", country: "PT", group: "Portugal", url: url("c") },
  ];
  const out = organizeLineup(input);
  assert.deepEqual(new Set(out.map((row) => row.url)), new Set(input.map((row) => row.url)));
});
