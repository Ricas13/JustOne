import test from "node:test";
import assert from "node:assert/strict";
import {
  AceStreamRegistry,
  buildAcePlaybackUrl,
  combinePlaybackCandidates,
  flattenAceSearchResults,
  normalizeAceName,
  scoreAceResult,
} from "../src/acestream.js";

test("normalizes quality and country suffixes without losing channel number", () => {
  assert.equal(normalizeAceName("RTP 1 FHD Portugal", "PT"), "rtp 1");
  assert.equal(normalizeAceName("Sky Sports F1 UHD UK", "GB"), "sky sports f1");
});

test("rejects a Portuguese channel candidate explicitly identified as Russian", () => {
  const scored = scoreAceResult(
    { name: "RTP 1", country: "PT" },
    { name: "RTP 1", countries: ["ru"], languages: ["rus"], status: 2, availability: 1 },
  );
  assert.equal(scored.eligible, false);
  assert.match(scored.reasons.join(" "), /country-mismatch:RU/);
});

test("accepts strong matching metadata but does not itself mark it verified", () => {
  const now = Date.UTC(2026, 8, 13, 18, 0, 0);
  const scored = scoreAceResult(
    { name: "RTP 1", country: "PT" },
    { name: "RTP 1 HD", countries: ["pt"], languages: ["por"], status: 2, availability: 1, availability_updated_at: now / 1000 },
    now,
  );
  assert.equal(scored.eligible, true);
  assert.equal(scored.strongMetadata, true);
});

test("flattens grouped search responses", () => {
  const rows = flattenAceSearchResults({ result: { results: [{ name: "RTP 1", items: [{ name: "RTP 1", infohash: "a".repeat(40), channel_id: 10 }] }] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, 10);
});

test("builds fixed MediaFlow playback URL", () => {
  const url = new URL(buildAcePlaybackUrl("http://mediaflow:8888/", "test-key", "b".repeat(40)));
  assert.equal(url.pathname, "/proxy/acestream/stream");
  assert.equal(url.searchParams.get("infohash"), "b".repeat(40));
  assert.equal(url.searchParams.get("api_password"), "test-key");
});

test("AceStream candidates can be primary or fallback without mutating DLHD order", () => {
  const dlhd = [{ label: "dlhd-1" }, { label: "dlhd-2" }];
  const ace = [{ label: "ace-1" }];
  assert.deepEqual(combinePlaybackCandidates(dlhd, ace, "first").map((x) => x.label), ["ace-1", "dlhd-1", "dlhd-2"]);
  assert.deepEqual(combinePlaybackCandidates(dlhd, ace, "fallback").map((x) => x.label), ["dlhd-1", "dlhd-2", "ace-1"]);
});

test("manual verification trusts an Ace channel id and new hashes inherit that trust", async () => {
  const tmp = `/tmp/ace-registry-${process.pid}-${Date.now()}.json`;
  const hash1 = "c".repeat(40);
  const hash2 = "d".repeat(40);
  let round = 0;
  const registry = new AceStreamRegistry({
    enabled: true,
    searchUrl: "http://ace.test/search",
    mediaflowUrl: "http://mediaflow.test:8888",
    stateFile: tmp,
    discoveryBatch: 1,
    pageSize: 20,
    minAvailability: 0.5,
  }, {
    fetch: async () => ({
      ok: true,
      json: async () => ({ result: { results: [{ items: [{
        name: "RTP 1 HD",
        infohash: round++ === 0 ? hash1 : hash2,
        channel_id: 99,
        countries: ["pt"],
        languages: ["por"],
        status: 2,
        availability: 1,
        availability_updated_at: Math.floor(Date.now() / 1000),
      }] }] } }),
    }),
  });

  const channel = { id: "channel.rtp1", name: "RTP 1", country: "PT", kind: "static" };
  await registry.discover([channel]);
  let diag = await registry.diagnostics([channel]);
  assert.equal(diag.channels[0].candidates[0].verification, "unverified");

  await registry.verify(channel.id, hash1);
  await registry.discover([channel]);
  diag = await registry.diagnostics([channel]);
  const inherited = diag.channels[0].candidates.find((x) => x.infohash === hash2);
  assert.equal(inherited.verification, "verified");
  assert.equal(inherited.verifiedBy, "trusted-channel-id");

  await fsCleanup(tmp);
});

async function fsCleanup(file) {
  const fs = await import("node:fs/promises");
  await fs.rm(file, { force: true });
  await fs.rm(`${file}.tmp`, { force: true });
}
