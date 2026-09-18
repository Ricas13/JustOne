import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_HTML } from "../src/ui.js";

test("admin UI presents JustOne as catalogue control with Dispatcharr as playback delivery", () => {
  assert.match(ADMIN_HTML, /JustOne Catalogue Control/);
  assert.match(ADMIN_HTML, /Dispatcharr handles playback to Jellyfin/);
  assert.match(ADMIN_HTML, /Dispatcharr delivery/);
  assert.match(ADMIN_HTML, /Provider M3Us/);
  assert.match(ADMIN_HTML, /Match, dedupe, order, EPG/);
  assert.match(ADMIN_HTML, /Import streams and broker playback/);
  assert.match(ADMIN_HTML, /Consumes Dispatcharr output/);
});

test("dashboard makes event suppression and standalone-event behaviour explicit", () => {
  assert.match(ADMIN_HTML, /events kept in EPG/);
  assert.match(ADMIN_HTML, /standalone events/);
  assert.match(ADMIN_HTML, /Scheduled events already carried on a normal channel remain EPG programmes only/);
  assert.match(ADMIN_HTML, /Only standalone \/ PPV-style events are published as separate event channels/);
  assert.match(ADMIN_HTML, /Events kept in normal-channel EPG/);
});

test("Dispatcharr filtered-input provisioning is a first-class workflow", () => {
  assert.match(ADMIN_HTML, /Filtered inputs/);
  assert.match(ADMIN_HTML, /JustOne's per-provider filtered M3Us and canonical EPG/);
  assert.match(ADMIN_HTML, /id="provisionDispatcharrButton"[^>]*disabled/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/inputs\/preview/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/inputs\/provision/);
  assert.match(ADMIN_HTML, /JSON\.stringify\(\{apply:true,refresh:true\}\)/);
  assert.match(ADMIN_HTML, /Raw provider credentials remain in JustOne/);
  assert.match(ADMIN_HTML, /DISPATCHARR_APPLY_ENABLED=false/);
  assert.match(ADMIN_HTML, /fresh\.applyEnabled/);
});

test("Dispatcharr channel and EPG reconciliation retains preview safety gates", () => {
  assert.match(ADMIN_HTML, /Channels \+ EPG/);
  assert.match(ADMIN_HTML, /id="applyDispatcharrButton"[^>]*disabled/);
  assert.match(ADMIN_HTML, /fresh\.readyForApply/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/preview/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/reconcile/);
  assert.match(ADMIN_HTML, /JSON\.stringify\(\{apply:true\}\)/);
  assert.match(ADMIN_HTML, /confirm\(warning\)/);
  assert.match(ADMIN_HTML, /delete stale events/);
  assert.match(ADMIN_HTML, /Scheduled events carried on normal channels remain EPG-only/);
});

test("provider source and EPG management keeps catalogue-relevant settings", () => {
  assert.match(ADMIN_HTML, /Provider EPG inputs/);
  assert.match(ADMIN_HTML, /Provider \/ family/);
  assert.match(ADMIN_HTML, /Account \/ line/);
  assert.match(ADMIN_HTML, /Max connections/);
  assert.match(ADMIN_HTML, /Priority \(lower first\)/);
  assert.match(ADMIN_HTML, /Copy filtered M3U/);
  assert.match(ADMIN_HTML, /priority '\+esc\(x\.priority/);
});

test("native playback telemetry is absent from the normal admin dashboard", () => {
  assert.doesNotMatch(ADMIN_HTML, /Live stream operations/);
  assert.doesNotMatch(ADMIN_HTML, /id="activeRelays"/);
  assert.doesNotMatch(ADMIN_HTML, /id="streamViewers"/);
  assert.doesNotMatch(ADMIN_HTML, /Copy proxy M3U/);
  assert.doesNotMatch(ADMIN_HTML, /\/api\/streams/);
  assert.doesNotMatch(ADMIN_HTML, /STREAM_PROXY_KEY/);
  assert.doesNotMatch(ADMIN_HTML, /HLS pacing/);
  assert.doesNotMatch(ADMIN_HTML, /Legacy Dispatcharr rollback/);
  assert.doesNotMatch(ADMIN_HTML, /Jellyfin connects directly to JustOne/);
});

test("embedded admin script remains syntactically valid", () => {
  const match = ADMIN_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "admin script should be present");
  assert.doesNotThrow(() => new Function(match[1]));
});
