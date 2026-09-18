import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_HTML } from "../src/ui.js";

test("admin UI keeps Dispatcharr behind an explicitly legacy rollback control", () => {
  assert.match(ADMIN_HTML, /Legacy Dispatcharr rollback/);
  assert.match(ADMIN_HTML, /Optional rollback\/reconciliation only/);
  assert.match(ADMIN_HTML, /id="applyDispatcharrButton"[^>]*disabled/);
  assert.match(ADMIN_HTML, /fresh\.readyForApply/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/preview/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/reconcile/);
  assert.match(ADMIN_HTML, /JSON\.stringify\(\{apply:true\}\)/);
  assert.match(ADMIN_HTML, /confirm\(warning\)/);
  assert.match(ADMIN_HTML, /await previewDispatcharr\(\)/);
});


test("admin UI exposes the native JustOne playback allocator as the primary live workflow", () => {
  assert.match(ADMIN_HTML, /Live stream operations/);
  assert.match(ADMIN_HTML, /id="activeRelays"/);
  assert.match(ADMIN_HTML, /id="streamViewers"/);
  assert.match(ADMIN_HTML, /id="liveStreams"/);
  assert.match(ADMIN_HTML, /id="streamAccounts"/);
  assert.match(ADMIN_HTML, /Copy proxy M3U/);
  assert.match(ADMIN_HTML, /\/api\/streams/);
  assert.match(ADMIN_HTML, /STREAM_PROXY_KEY/);
  assert.match(ADMIN_HTML, /Jellyfin connects directly to JustOne/);
});

test("playlist edit flow exposes allocator-critical provider, account, limit and priority settings", () => {
  assert.match(ADMIN_HTML, /Provider \/ family/);
  assert.match(ADMIN_HTML, /Account \/ line/);
  assert.match(ADMIN_HTML, /Max connections/);
  assert.match(ADMIN_HTML, /Priority \(lower first\)/);
  assert.match(ADMIN_HTML, /priority '\+esc\(x\.priority/);
});

test("embedded admin script remains syntactically valid", () => {
  const match = ADMIN_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "admin script should be present");
  assert.doesNotThrow(() => new Function(match[1]));
});


test("live operations dashboard shows source routing, media details and real throughput", () => {
  assert.match(ADMIN_HTML, /Live stream operations/);
  assert.match(ADMIN_HTML, /Provider input/);
  assert.match(ADMIN_HTML, /Proxy output/);
  assert.match(ADMIN_HTML, /Processing · no transcode/);
  assert.match(ADMIN_HTML, /PLAYLIST \/ LINE/);
  assert.match(ADMIN_HTML, /Provider channel:/);
  assert.match(ADMIN_HTML, /Stream host:/);
  assert.match(ADMIN_HTML, /Advertised rate/);
  assert.match(ADMIN_HTML, /Transferred in/);
  assert.match(ADMIN_HTML, /Transferred out/);
  assert.match(ADMIN_HTML, /mediaValue\(x\)/);
  assert.match(ADMIN_HTML, /x\.sourceName/);
  assert.match(ADMIN_HTML, /x\.egressMbps/);
});


test("live operations dashboard exposes HLS pacing diagnostics", () => {
  assert.match(ADMIN_HTML, /HLS pacing/);
  assert.match(ADMIN_HTML, /HLS segment/);
  assert.match(ADMIN_HTML, /Real-time/);
  assert.match(ADMIN_HTML, /hlsSegmentDownloadMs/);
  assert.match(ADMIN_HTML, /hlsSegmentDurationMs/);
});
