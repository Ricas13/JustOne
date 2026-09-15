import test from "node:test";
import assert from "node:assert/strict";
import { createDlhdMatcher, isEventLikeRow } from "../src/dlhd-matcher.js";

const reference = {
  channels: [],
  events: [
    { id: "arg-ven", kind: "event", name: "⚽ 🇦🇷 South American Championship : Argentina 🇦🇷 vs Venezuela 🇻🇪", aliases: [] },
    { id: "crb-sport", kind: "event", name: "⚽ 🇧🇷 Brazil - Serie B : CRB 🇧🇷 vs Sport Recife 🇧🇷", aliases: [] },
    { id: "daejeon-kyoto", kind: "event", name: "⚽ 🇯🇵 AFC Champions League Elite : Daejeon Citizen 🇰🇷 vs Kyoto Sanga 🇯🇵", aliases: [] },
  ],
};

test("event fuzzy matching keeps national-team country names", () => {
  const matcher = createDlhdMatcher(reference);
  const matches = matcher.match({ name: "Argentina vs Venezuela", group: "EPG Live Event" });
  assert.ok(matches.some((x) => x.id === "arg-ven"));
});

test("event fuzzy matching keeps team names that contain Sport", () => {
  const matcher = createDlhdMatcher(reference);
  const matches = matcher.match({ name: "CRB x Sport", group: "EPG Live Event" });
  assert.ok(matches.some((x) => x.id === "crb-sport"));
});

test("short provider fixture titles match longer competition-prefixed DLHD titles", () => {
  const matcher = createDlhdMatcher(reference);
  const matches = matcher.match({ name: "Daejeon Citizen v Kyoto Sanga", group: "EPG Live Event" });
  assert.ok(matches.some((x) => x.id === "daejeon-kyoto"));
});

test("foreign normal sports channels are retained as EPG event carriers without direct event matching", () => {
  const row = { name: "BR | PREMIERE 3 HD", tvgName: "Premiere 3", group: "Brazil Sports", tvgId: "premiere3.br" };
  assert.equal(isEventLikeRow(row), true);
  const matcher = createDlhdMatcher(reference);
  assert.deepEqual(matcher.match(row), []);
});

test("Asian and Latin-American sports brands are eligible EPG carriers", () => {
  assert.equal(isEventLikeRow({ name: "beIN Sports 4", group: "Qatar" }), true);
  assert.equal(isEventLikeRow({ name: "TyC Sports", group: "Argentina" }), true);
  assert.equal(isEventLikeRow({ name: "SporTV 2", group: "Brazil" }), true);
  assert.equal(isEventLikeRow({ name: "TUDN", group: "Mexico" }), true);
});
