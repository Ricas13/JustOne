import test from "node:test";
import assert from "node:assert/strict";
import { createDlhdMatcher, isEventLikeRow } from "../src/dlhd-matcher.js";
import { mappingAllowedForCountries } from "../src/catalog.js";

const reference = {
  channels: [
    { id:"bbc", kind:"channel", name:"BBC One UK", aliases:["BBC One UK"] },
    { id:"bbc4", kind:"channel", name:"BBC Four UK", aliases:["BBC Four UK"] },
    { id:"rtp", kind:"channel", name:"RTP 1 Portugal", aliases:["RTP 1 Portugal"] },
    { id:"eleven1", kind:"channel", name:"Eleven Sports 1 Portugal", aliases:["Eleven Sports 1 Portugal"] },
    { id:"daznuk", kind:"channel", name:"DAZN 1 UK", aliases:["DAZN 1 UK"] },
    { id:"espn", kind:"channel", name:"ESPN USA", aliases:["ESPN USA"] },
    { id:"bravo", kind:"channel", name:"Bravo USA", aliases:["Bravo USA"] },
    { id:"sky", kind:"channel", name:"Sky Sports Main Event UK", aliases:["Sky Sports Main Event UK"] },
    { id:"canal", kind:"channel", name:"Canal Plus France", aliases:["Canal Plus France"] },
    { id:"benfica", kind:"channel", name:"Benfica TV PT", aliases:["Benfica TV PT"] },
    { id:"tnt1", kind:"channel", name:"TNT Sports 1 UK", aliases:["TNT Sports 1 UK"] },
    { id:"via1", kind:"channel", name:"Viaplay Sports 1 UK", aliases:["Viaplay Sports 1 UK"] },
    { id:"abcny", kind:"channel", name:"ABC NY USA", aliases:["ABC NY USA"] },
    { id:"cbsny", kind:"channel", name:"CBSNY USA", aliases:["CBSNY USA"] },
    { id:"nbcny", kind:"channel", name:"NBCNY USA", aliases:["NBCNY USA"] },
    { id:"foxny", kind:"channel", name:"FOXNY USA", aliases:["FOXNY USA"] },
    { id:"pix", kind:"channel", name:"CW PIX 11 USA", aliases:["CW PIX 11 USA"] },
    { id:"my9", kind:"channel", name:"MY9TV USA", aliases:["MY9TV USA"] },
    { id:"btn", kind:"channel", name:"BIG TEN Network (BTN USA)", aliases:["BIG TEN Network (BTN USA)"] },
    { id:"mgm", kind:"channel", name:"MGM+ USA / Epix", aliases:["MGM+ USA / Epix"] },
    { id:"gal", kind:"channel", name:"Galavisi贸n USA", aliases:["Galavisi贸n USA"] },
  ],
  events: [
    { id:"evt1", kind:"event", name:"England - Premier League : Arsenal vs Chelsea", aliases:["England - Premier League : Arsenal vs Chelsea","Sky Sports Main Event UK"] },
    { id:"evt2", kind:"event", name:"Scotland - League Cup : Stenhousemuir vs Hearts", aliases:["Scotland - League Cup : Stenhousemuir vs Hearts"] },
    { id:"evt3", kind:"event", name:"Field Hockey : New England College vs UMass Boston", aliases:["Field Hockey : New England College vs UMass Boston"] },
    { id:"evt4", kind:"event", name:"Baseball MLB : Dodgers vs Reds", aliases:["Baseball MLB : Dodgers vs Reds"] },
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

test("static aliases cover legacy brands, numbering and affiliate callsigns", () => {
  const matcher = createDlhdMatcher(reference);
  const cases = [
    [{ name:"UK| BBC 4 HD", group:"UK" }, "bbc4"],
    [{ name:"PT| BTV 1 HD", group:"Portugal" }, "benfica"],
    [{ name:"UK| TNT SPORTS 01 HD", group:"UK Sports" }, "tnt1"],
    [{ name:"UK| BT SPORT 1 HD", group:"UK Sports" }, "tnt1"],
    [{ name:"UK| PREMIER SPORTS 1 HD", group:"UK Sports" }, "via1"],
    [{ name:"US| WABC 7 HD", group:"USA" }, "abcny"],
    [{ name:"US| WCBS 2 HD", group:"USA" }, "cbsny"],
    [{ name:"US| WNBC 4 HD", group:"USA" }, "nbcny"],
    [{ name:"US| WNYW 5 HD", group:"USA" }, "foxny"],
    [{ name:"US| WPIX 11 HD", group:"USA" }, "pix"],
    [{ name:"US| WWOR 9 HD", group:"USA" }, "my9"],
    [{ name:"US| BTN HD", group:"USA Sports" }, "btn"],
    [{ name:"US| EPIX HD", group:"USA Movies" }, "mgm"],
    [{ name:"US| GALAVISION HD", group:"USA" }, "gal"],
  ];
  for (const [row, expected] of cases) {
    assert.ok(matcher.match(row).some((x)=>x.id === expected), `${row.name} should match ${expected}`);
  }
});

test("Portugal Eleven Sports safely follows the DAZN 1-5 rebrand", () => {
  const matcher = createDlhdMatcher(reference);
  const pt = matcher.match({ name:"PT| DAZN 1 FHD", group:"Portugal Sports", tvgId:"DAZN1.pt" });
  assert.ok(pt.some((x)=>x.id === "eleven1"));
  assert.ok(!pt.some((x)=>x.id === "daznuk"));

  const uk = matcher.match({ name:"UK| DAZN 1 HD", group:"UK Sports", tvgId:"DAZN1.uk" });
  assert.ok(uk.some((x)=>x.id === "daznuk"));
  assert.ok(!uk.some((x)=>x.id === "eleven1"));
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

test("event-group matching handles provider team feeds and league abbreviations", () => {
  const matcher = createDlhdMatcher(reference);
  const epl = matcher.match({ name:"UK| EPL : ARSENAL", group:"EU | UK LIVE EVENTS-PPV" });
  assert.ok(epl.some((x)=>x.id === "evt1"));
  const named = matcher.match({ name:"UK| LIVE FOOTBALL 01: Stenhousemuir vs Hearts 7:45pm", group:"EU | UK LIVE EVENTS-PPV" });
  assert.ok(named.some((x)=>x.id === "evt2"));
  assert.equal(isEventLikeRow({ name:"UK| EPL : ARSENAL", group:"EU | UK LIVE EVENTS-PPV" }), true);
});

test("event matching preserves meaningful bracket content from provider feeds", () => {
  const matcher = createDlhdMatcher(reference);
  const flo = matcher.match({
    name:"US| FLO SPORTS 002 [New England College vs UMass_Boston _ Field Hockey (NEC vs UMass_Boston) (2026-09-14 14:00:00)]",
    group:"AM | USA FLO",
  });
  assert.ok(flo.some((x)=>x.id === "evt3"));
});

test("event matching normalizes x separators and embedded start stop timestamps", () => {
  const matcher = createDlhdMatcher(reference);
  const mlb = matcher.match({
    name:"US| MLB LIVE 01 : Dodgers x Reds start:2026-09-14 23:40:00 stop:2026-09-15 06:53:20",
    group:"AM | USA MLB",
  });
  assert.ok(mlb.some((x)=>x.id === "evt4"));
});

test("near-match suggestions identify likely static aliases without auto-merging", () => {
  const matcher = createDlhdMatcher(reference);
  const suggestions = matcher.suggest({ name:"UK| BBC ONE LONDON", group:"UK General" }, { kind:"channel" });
  assert.equal(suggestions[0]?.ref.id, "bbc");
  assert.ok(suggestions[0]?.score > 0.4);
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
