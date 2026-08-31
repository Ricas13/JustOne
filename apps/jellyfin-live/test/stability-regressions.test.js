import test from "node:test";
import assert from "node:assert/strict";
import { organizeLineup } from "../src/lineup.js";

test("linear sports networks stay in country TV even when provider group is a sport", () => {
  const out = organizeLineup([
    {
      id: "sky-football",
      kind: "static",
      name: "Sky Sports Football UK",
      country: "GB",
      group: "Football",
      url: "https://resolver.example/play/live/100.ts?token=exact",
    },
    {
      id: "sky-f1",
      kind: "static",
      name: "Sky Sports F1 - UK",
      country: "GB",
      group: "Formula 1",
      url: "https://resolver.example/play/live/101.ts?token=exact",
    },
  ]);

  assert.equal(out.find((x) => x.id === "sky-football")?.group, "TV | UK");
  assert.equal(out.find((x) => x.id === "sky-football")?.kind, "static");
  assert.equal(out.find((x) => x.id === "sky-f1")?.group, "TV | UK");
  assert.equal(out.find((x) => x.id === "sky-f1")?.kind, "static");
});

test("sports events with a linear network source suffix still become event cards without fake timing", () => {
  const url = "https://resolver.example/play/live/501.ts?key=secret&token=x%2Fy";
  const [event] = organizeLineup([
    {
      id: "chelsea-luton",
      kind: "static",
      name: "Chelsea vs Luton Town - Sky Sports Football UK",
      country: "GB",
      group: "Football",
      url,
    },
  ]);

  assert.equal(event.group, "Sports | Football");
  assert.equal(event.kind, "sport-slot");
  assert.equal(event.name, "Chelsea vs Luton Town - Sky Sports Football");
  assert.deepEqual(event.programmes, []);
  assert.equal(event.url, url);
});
