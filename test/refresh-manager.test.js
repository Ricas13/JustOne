import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshManager } from "../src/refresh-manager.js";

test("refresh manager starts asynchronously, passes source mode and prevents overlaps", async () => {
  let release;
  let receivedMode = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = createRefreshManager(async ({ onProgress, sourceMode }) => {
    receivedMode = sourceMode;
    onProgress({ phase:"scanning-source", currentSource:"Line 1", rows:123, megabytes:4.2 });
    await gate;
    return {
      sourceMode,
      channels:[
        { referenceKind:"channel" },
        { referenceKind:"event" },
      ],
      dlhdStatus:{ matchedReferences:2, totalReferences:3 },
    };
  });

  const first = manager.start("test", { sourceMode:"cache" });
  assert.equal(first.started, true);
  assert.equal(manager.status().running, true);
  assert.equal(manager.status().sourceMode, "cache");

  const second = manager.start("duplicate", { sourceMode:"network" });
  assert.equal(second.started, false);
  assert.equal(manager.status().currentSource, "Line 1");
  assert.equal(manager.status().progress.rows, 123);

  release();
  await manager.wait();
  const finished = manager.status();
  assert.equal(receivedMode, "cache");
  assert.equal(finished.running, false);
  assert.equal(finished.phase, "complete");
  assert.equal(finished.summary.sourceMode, "cache");
  assert.equal(finished.summary.staticChannels, 1);
  assert.equal(finished.summary.events, 1);
  assert.equal(finished.summary.channels, 2);
});

test("refresh manager records errors without throwing through the HTTP caller", async () => {
  const manager = createRefreshManager(async () => {
    throw new Error("provider failed");
  });
  const started = manager.start("test-error", { sourceMode:"network" });
  assert.equal(started.started, true);
  await manager.wait();
  const finished = manager.status();
  assert.equal(finished.running, false);
  assert.equal(finished.phase, "failed");
  assert.equal(finished.lastError, "provider failed");
});
