import test from "node:test";
import assert from "node:assert/strict";
import { createDlhdMatcher } from "../src/dlhd-matcher.js";
import { mappingAllowedForCountries } from "../src/catalog.js";

const reference = {
  channels: [
    { id:"bbc", kind:"channel", name:"BBC One UK", aliases:["BBC One UK"] },
    { id:"rtp", kind:"channel", name:"RTP 1 Portugal", aliases:["RTP 1 Portugal"] },
    { id:"espn", kind:"channel", name:"ESPN USA", aliases:["ESPN USA"] },
    { id:"bravo", kind:"channel", name:"Bravo USA", aliases:["Bravo USA"] },
    { id:"sky", kind:"channel", name:"Sky Sports Main Event UK", aliases:["Sky Sports Main Event UK"] },
    { id:"canal", kind:"channel", name:"Canal Plus France", aliases:["Canal Plus France"] },
  ],
  events: [
    { id:"evt1", kind:"event", name:"England - Premier League : Arsenal vs Chelsea", aliases:["England - Premier League : Arsenal vs Chelsea","Sky Sports Main Event UK"] },
  ],
};

const allowed = new Set(["GB","PT","US"]);

test("indexed matcher resolves real provider naming variants", () => {
  const matcher = createDlhdMatcher(reference);

  assert.ok(matcher.match({ name:"UK| BBC 1 FHD", group:"UK" }).some((x)=>x.id === "bbc"));
  assert.ok(matcher.match({ name:"PT| RTP 1 FHD", group:"Portugal" }).some((x)=>x.id === "rtp"));
  assert.ok(matcher.match({ name:"US| BRAVO (EAST)", group:"USA" }).some((x)=>x.id === "bravo"));
  assert.ok(matcher.match({ name:"UK| SKY SPORTS MAIN EVENTS HD", group:"UK Sports" }).some((x)=>x.id === "sky"));
});

test("indexed matcher resolves linked event channels", () => {
  const matcher = createDlhdMatcher(reference);
  const event = matcher.match({ name:"Sky Sports Main Event HD", group:"UK Sports" });
  assert.ok(event.some((x)=>x.id === "evt1"));
});

test("fuzzy event matching accepts two-team v/vs naming differences", () => {
  const matcher = createDlhdMatcher(reference);
  const event = matcher.match({ name:"Arsenal v Chelsea FHD", group:"Live Events" });
  assert.ok(event.some((x)=>x.id === "evt1"));
});

test("country policy keeps all DLHD events but only GB PT US static channels", () => {
  const matcher = createDlhdMatcher(reference);

  const ukRow = { name:"UK| BBC 1 HD", group:"UK" };
  const ukRef = matcher.match(ukRow).find((x)=>x.id === "bbc");
  assert.equal(mappingAllowedForCountries(ukRow, ukRef, allowed), true);

  const frRow = { name:"Canal Plus France HD", group:"France" };
  const frRef = matcher.match(frRow).find((x)=>x.id === "canal");
  assert.equal(mappingAllowedForCountries(frRow, frRef, allowed), false);

  const eventRow = { name:"Arsenal v Chelsea FHD", group:"Spain Events" };
  const eventRef = matcher.match(eventRow).find((x)=>x.id === "evt1");
  assert.equal(mappingAllowedForCountries(eventRow, eventRef, allowed), true);
});
