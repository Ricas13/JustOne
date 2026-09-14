import test from "node:test";
import assert from "node:assert/strict";
import { createDlhdMatcher } from "../src/dlhd-matcher.js";
import { mappingAllowedForCountries } from "../src/catalog.js";

const reference = {
  channels: [
    { id:"bbc", kind:"channel", name:"BBC One", aliases:["BBC One"] },
    { id:"rtp", kind:"channel", name:"RTP 1", aliases:["RTP 1"] },
    { id:"espn", kind:"channel", name:"ESPN USA", aliases:["ESPN USA"] },
    { id:"canal", kind:"channel", name:"Canal Plus France", aliases:["Canal Plus France"] },
  ],
  events: [
    { id:"evt1", kind:"event", name:"England - Premier League : Arsenal vs Chelsea", aliases:["England - Premier League : Arsenal vs Chelsea","Sky Sports Main Event"] },
  ],
};

const allowed = new Set(["GB","PT","US"]);

test("indexed matcher resolves static variants and linked event channels", () => {
  const matcher = createDlhdMatcher(reference);
  const bbc = matcher.match({ name:"UK: BBC One FHD", group:"United Kingdom" });
  assert.deepEqual(bbc.map((x)=>x.id), ["bbc"]);

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

  const ukRow = { name:"BBC One HD", group:"UK" };
  const ukRef = matcher.match(ukRow).find((x)=>x.id === "bbc");
  assert.equal(mappingAllowedForCountries(ukRow, ukRef, allowed), true);

  const frRow = { name:"Canal Plus France HD", group:"France" };
  const frRef = matcher.match(frRow).find((x)=>x.id === "canal");
  assert.equal(mappingAllowedForCountries(frRow, frRef, allowed), false);

  const eventRow = { name:"Arsenal v Chelsea FHD", group:"Spain Events" };
  const eventRef = matcher.match(eventRow).find((x)=>x.id === "evt1");
  assert.equal(mappingAllowedForCountries(eventRow, eventRef, allowed), true);
});
