import test from "node:test";
import assert from "node:assert/strict";
import {
  liveSourceManagerStats,
  noteLiveSourceObservation,
  preferredLiveSource,
  qualifyLiveSources,
  resetLiveSourceManagerForTests,
} from "../src/liveSourceManager.js";

const endpoints = [
  { provider: "primary", url: "http://primary.test/stream/370.m3u8" },
  { provider: "standby", url: "http://standby.test/stream/370.m3u8" },
];

test("parallel qualification scores all healthy candidates and remembers a winner", async () => {
  resetLiveSourceManagerForTests();
  let inFlight = 0;
  let maxInFlight = 0;
  const probe = async (endpoint) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, endpoint.provider === "primary" ? 60 : 10));
    inFlight -= 1;
    return endpoint.url;
  };

  const selected = await qualifyLiveSources("370", endpoints, probe, { force: true });
  assert.equal(maxInFlight, 2, "both candidate probes run concurrently");
  assert.equal(selected.provider, "standby", "lower-latency candidate wins when history is otherwise equal");

  const preferred = preferredLiveSource("370", endpoints, probe, { maxAgeMs: 60_000 });
  assert.equal(preferred?.provider, "standby");
  const stats = liveSourceManagerStats();
  assert.equal(stats.switchConfirmations, 3, "healthy score-only switching requires sustained superiority by default");
  assert.equal(stats.fallbackScanEvery, 12, "aggregate/legacy fallback sampling is slower once exact redundancy is warm");
  assert.equal(stats.managers.length, 1);
  assert.equal(stats.managers[0].challengerProvider, null);
  assert.equal(stats.managers[0].challengerWins, 0);
  assert.equal(stats.managers[0].candidates.length, 2);
});

test("media-validated exact Daddy candidate is preferred over a faster aggregate fallback", async () => {
  resetLiveSourceManagerForTests();
  const candidates = [
    { provider: "legacy-dlhd-web", url: "http://legacy.test/api/stream/454.m3u8" },
    { provider: "amddeus-dlhd-proxy", url: "http://dlhd.test/stream/454.m3u8" },
    { provider: "daddy:stream:e1:s1", url: "http://dlhd.test/candidate/454/stream/0/0.m3u8" },
    { provider: "daddy:watch:e1:s1", url: "http://dlhd.test/candidate/454/watch/0/0.m3u8" },
  ];
  const probe = async (endpoint) => {
    await new Promise((resolve) => setTimeout(resolve, endpoint.provider.startsWith("daddy:") ? 25 : 1));
    return endpoint.url;
  };

  const selected = await qualifyLiveSources("454", candidates, probe, { force: true });
  assert.match(selected.provider, /^daddy:/, "successful exact candidates outrank aggregate/legacy resolver paths");

  const stats = liveSourceManagerStats();
  const selectedRows = stats.managers[0].candidates.filter((row) => row.selected);
  assert.equal(selectedRows.length, 1);
  assert.match(selectedRows[0].provider, /^daddy:/);
});

test("repeated active-source failures switch to a recently healthy warm standby", async () => {
  resetLiveSourceManagerForTests();
  const probe = async (endpoint) => endpoint.url;

  await qualifyLiveSources("370", endpoints, probe, { force: true });
  const initial = preferredLiveSource("370", endpoints, probe, { maxAgeMs: 60_000 });
  assert.ok(initial);
  const standby = endpoints.find((endpoint) => endpoint.url !== initial.url);
  assert.ok(standby);

  noteLiveSourceObservation("370", standby.url, { ok: true, latencyMs: 20, status: 200 });
  noteLiveSourceObservation("370", initial.url, { ok: false, latencyMs: 100, status: 500 });
  noteLiveSourceObservation("370", initial.url, { ok: false, latencyMs: 100, status: 500 });

  const switched = preferredLiveSource("370", endpoints, probe, { maxAgeMs: 60_000 });
  assert.equal(switched?.url, standby.url, "real repeated failures still promote the warm standby immediately");
  const stats = liveSourceManagerStats();
  assert.equal(stats.managers[0].selectedProvider, standby.provider);
  assert.equal(stats.managers[0].challengerWins, 0, "failure-driven failover does not wait for score confirmations");
});
