import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcharrApplyManager } from "../src/dispatcharr-apply-manager.js";

test("Dispatcharr apply manager returns immediately and completes in background", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const manager = createDispatcharrApplyManager(async (snapshot, options) => {
    calls.push({ snapshot, options });
    await gate;
    return { counts: { update: 614 }, note: "done" };
  });

  const started = manager.start({ channels: [{ tvgId: "justone.channel.test" }] });
  assert.equal(started.started, true);
  assert.equal(started.status.running, true);
  assert.equal(calls.length, 1);

  const duplicateStart = manager.start({ channels: [] });
  assert.equal(duplicateStart.started, false);
  assert.equal(duplicateStart.status.id, started.status.id);

  release();
  await manager.wait();

  const finished = manager.status();
  assert.equal(finished.running, false);
  assert.equal(finished.phase, "complete");
  assert.equal(finished.lastError, null);
  assert.deepEqual(finished.result.counts, { update: 614 });
  assert.equal(finished.result.note, "done");
  assert.equal(calls[0].options.apply, true);
});

test("Dispatcharr apply manager captures failures without rejecting the HTTP starter", async () => {
  const manager = createDispatcharrApplyManager(async () => {
    throw new Error("Dispatcharr exploded");
  });

  const started = manager.start({ channels: [] });
  assert.equal(started.started, true);
  await manager.wait();

  const finished = manager.status();
  assert.equal(finished.running, false);
  assert.equal(finished.phase, "failed");
  assert.equal(finished.lastError, "Dispatcharr exploded");
});
