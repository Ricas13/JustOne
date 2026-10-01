import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcharrAutoSyncManager } from "../src/dispatcharr-auto-sync-manager.js";

class FakeClient {
  constructor() {
    this.phase = "before";
    this.accounts = [{
      id: 1,
      name: "JustOne | Provider A",
      status: "success",
      updated_at: "2026-10-01T10:00:00Z",
      custom_properties: {
        justone_managed: true,
        justone_role: "filtered_m3u",
        justone_source_id: "a",
      },
    }];
    this.epg = [{
      id: 2,
      name: "JustOne | Canonical EPG",
      status: "success",
      updated_at: "2026-10-01T10:00:00Z",
      custom_properties: {
        justone_managed: true,
        justone_role: "canonical_epg",
      },
    }];
  }

  async list(path) {
    if (this.phase === "after") {
      this.accounts[0].status = "success";
      this.accounts[0].updated_at = "2026-10-01T11:00:00Z";
      this.epg[0].status = "success";
      this.epg[0].updated_at = "2026-10-01T11:00:00Z";
    }
    if (path === "/api/m3u/accounts/") return structuredClone(this.accounts);
    if (path === "/api/epg/sources/") return structuredClone(this.epg);
    throw new Error(`unexpected list ${path}`);
  }
}

test("automatic Dispatcharr sync refreshes inputs, waits for imports, previews, then applies", async () => {
  const client = new FakeClient();
  const calls = [];
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({ sources: [{ id: "a" }] }),
    loadCurrentSnapshot: async () => ({ channels: [{ tvgId: "justone.channel.a" }] }),
    provision: async (_state, options) => {
      calls.push(["provision", options.apply, options.refresh]);
      client.phase = "after";
      return { counts: { "m3u:unchanged": 1, "epg:unchanged": 1 } };
    },
    reconcile: async (_snapshot, options) => {
      calls.push(["reconcile", options.apply]);
      return options.apply
        ? { readyForApply: true, counts: { update: 1 }, note: "applied" }
        : { readyForApply: true, blockers: [], counts: { update: 1 } };
    },
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  const started = manager.start("test-refresh");
  assert.equal(started.started, true);
  await manager.wait();

  assert.deepEqual(calls, [
    ["provision", true, true],
    ["reconcile", false],
    ["reconcile", true],
  ]);
  const status = manager.status();
  assert.equal(status.phase, "complete");
  assert.equal(status.lastError, null);
  assert.equal(status.result.note, "applied");
});

test("automatic Dispatcharr sync fails closed when an import errors", async () => {
  const client = new FakeClient();
  const calls = [];
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({ sources: [{ id: "a" }] }),
    loadCurrentSnapshot: async () => ({ channels: [] }),
    provision: async () => {
      client.phase = "error";
      client.list = async (path) => {
        if (path === "/api/m3u/accounts/") {
          return [{
            ...client.accounts[0],
            status: "error",
            last_message: "M3U parse failed",
          }];
        }
        if (path === "/api/epg/sources/") return structuredClone(client.epg);
        throw new Error(`unexpected list ${path}`);
      };
      return { counts: {} };
    },
    reconcile: async (_snapshot, options) => {
      calls.push(options.apply);
      return { readyForApply: true, blockers: [] };
    },
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  manager.start("test-error");
  await manager.wait();

  const status = manager.status();
  assert.equal(status.phase, "failed");
  assert.match(status.lastError, /M3U parse failed/);
  assert.deepEqual(calls, []);
});

test("automatic Dispatcharr sync never applies while reconciliation preview has blockers", async () => {
  const client = new FakeClient();
  const calls = [];
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({ sources: [{ id: "a" }] }),
    loadCurrentSnapshot: async () => ({ channels: [] }),
    provision: async () => {
      client.phase = "after";
      return { counts: {} };
    },
    reconcile: async (_snapshot, options) => {
      calls.push(options.apply);
      return {
        readyForApply: false,
        blockers: ["1 channel(s) waiting for Dispatcharr stream import"],
      };
    },
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  manager.start("blocked");
  await manager.wait();

  const status = manager.status();
  assert.equal(status.phase, "failed");
  assert.match(status.lastError, /waiting for Dispatcharr stream import/);
  assert.deepEqual(calls, [false]);
});

test("automatic Dispatcharr sync is single-flight and respects disabled settings", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = new FakeClient();
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({}),
    loadCurrentSnapshot: async () => ({}),
    provision: async () => {
      await gate;
      client.phase = "after";
      return { counts: {} };
    },
    reconcile: async () => ({ readyForApply: true, blockers: [], counts: {} }),
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  const first = manager.start("one");
  const second = manager.start("two");
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.status.id, first.status.id);
  release();
  await manager.wait();

  const disabled = createDispatcharrAutoSyncManager({
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: false,
      autoSyncEnabled: true,
    },
  });
  const skipped = disabled.start("disabled");
  assert.equal(skipped.started, false);
  assert.equal(skipped.status.phase, "disabled");
  assert.match(skipped.status.lastError, /APPLY_ENABLED=false/);
});


test("automatic Dispatcharr sync queues a second pass when a refresh completes mid-sync", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let generation = 0;
  let provisionCalls = 0;
  const client = {
    async list(path) {
      const common = {
        status: "success",
        updated_at: `2026-10-01T1${generation}:00:00Z`,
      };
      if (path === "/api/m3u/accounts/") return [{
        id: 1,
        name: "JustOne | Provider A",
        ...common,
        custom_properties: { justone_managed:true, justone_role:"filtered_m3u", justone_source_id:"a" },
      }];
      if (path === "/api/epg/sources/") return [{
        id: 2,
        name: "JustOne | Canonical EPG",
        ...common,
        custom_properties: { justone_managed:true, justone_role:"canonical_epg" },
      }];
      throw new Error(`unexpected list ${path}`);
    },
  };
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({}),
    loadCurrentSnapshot: async () => ({ channels: [] }),
    provision: async () => {
      provisionCalls += 1;
      if (provisionCalls === 1) await firstGate;
      generation += 1;
      return { counts: {} };
    },
    reconcile: async (_snapshot, options) => ({
      readyForApply: true,
      blockers: [],
      counts: options.apply ? { update: 1 } : {},
    }),
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  const first = manager.start("first-refresh");
  const queued = manager.start("newer-refresh");
  assert.equal(first.started, true);
  assert.equal(queued.started, false);
  assert.equal(queued.queued, true);

  releaseFirst();
  await manager.wait();
  await new Promise((resolve) => setImmediate(resolve));
  const secondPass = manager.wait();
  if (secondPass) await secondPass;

  assert.equal(provisionCalls, 2);
  assert.equal(manager.status().phase, "complete");
  assert.equal(manager.status().reason, "newer-refresh");
});

test("a stale pre-existing Dispatcharr error waits for the fresh import instead of failing immediately", async () => {
  let refreshed = false;
  const client = {
    async list(path) {
      if (path === "/api/m3u/accounts/") return [{
        id: 1,
        name: "JustOne | Provider A",
        status: refreshed ? "success" : "error",
        last_message: refreshed ? "Imported" : "Old failure",
        updated_at: refreshed ? "2026-10-01T12:00:00Z" : "2026-10-01T10:00:00Z",
        custom_properties: { justone_managed:true, justone_role:"filtered_m3u", justone_source_id:"a" },
      }];
      if (path === "/api/epg/sources/") return [{
        id: 2,
        name: "JustOne | Canonical EPG",
        status: "success",
        updated_at: refreshed ? "2026-10-01T12:00:00Z" : "2026-10-01T10:00:00Z",
        custom_properties: { justone_managed:true, justone_role:"canonical_epg" },
      }];
      throw new Error(`unexpected list ${path}`);
    },
  };
  const manager = createDispatcharrAutoSyncManager({
    makeClient: () => client,
    loadCurrentState: async () => ({}),
    loadCurrentSnapshot: async () => ({ channels: [] }),
    provision: async () => {
      refreshed = true;
      return { counts: {} };
    },
    reconcile: async (_snapshot, options) => ({
      readyForApply: true,
      blockers: [],
      counts: options.apply ? { update: 1 } : {},
    }),
    settings: {
      url: "http://dispatcharr:9191",
      applyEnabled: true,
      autoSyncEnabled: true,
      autoSyncPollSeconds: 0,
      autoSyncTimeoutMinutes: 1,
    },
    sleepFn: async () => {},
  });

  manager.start("recover-old-error");
  await manager.wait();
  assert.equal(manager.status().phase, "complete");
  assert.equal(manager.status().lastError, null);
});
