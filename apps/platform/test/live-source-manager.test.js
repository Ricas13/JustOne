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
  assert.equal(stats.managers.length, 1);
  assert.equal(stats.managers[0].candidates.length, 2);
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
  assert.equal(switched?.url, standby.url);
  const stats = liveSourceManagerStats();
  assert.equal(stats.managers[0].selectedProvider, standby.provider);
});
