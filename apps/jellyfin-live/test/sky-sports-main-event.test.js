import test from "node:test";
import assert from "node:assert/strict";
import { organizeLineup } from "../src/lineup.js";

test("Sky Sports Main Event stays in the UK lineup without a country suffix", () => {
  const out = organizeLineup([
    {
      id: "sky-main-event",
      kind: "static",
      name: "Sky Sports Main Event",
      country: "",
      group: "Sports",
      url: "https://example/sky-main-event",
    },
    {
      id: "abc",
      kind: "static",
      name: "ABC USA",
      country: "US",
      group: "USA",
      url: "https://example/abc",
    },
  ]);

  const sky = out.find((channel) => channel.id === "sky-main-event");
  assert.equal(sky?.country, "GB");
  assert.equal(sky?.group, "TV | UK");
  assert.ok(sky?.number >= 1000 && sky?.number < 2000);
  assert.ok(out.findIndex((channel) => channel.id === "sky-main-event") < out.findIndex((channel) => channel.id === "abc"));
});
