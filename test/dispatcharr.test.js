import test from "node:test";
import assert from "node:assert/strict";
import { planDispatcharrInputs, provisionDispatcharrInputs, rankFromName } from "../src/dispatcharr.js";

test("Dispatcharr reconciler reads JustOne stream rank", () => {
  assert.equal(rankFromName("BBC One [JO:007] [HD]"), 7);
  assert.ok(rankFromName("BBC One") > 1000000);
});

class FakeClient {
  constructor({ accounts = [], epg = [] } = {}) {
    this.accounts = structuredClone(accounts);
    this.epg = structuredClone(epg);
    this.calls = [];
    this.nextId = 100;
  }
  async list(path) {
    if (path === "/api/m3u/accounts/") return this.accounts;
    if (path === "/api/epg/sources/") return this.epg;
    throw new Error(`unexpected list ${path}`);
  }
  async request(path, { method = "GET", body } = {}) {
    this.calls.push({ path, method, body });
    if (path === "/api/m3u/accounts/" && method === "POST") {
      const row = { ...body, id: this.nextId++ };
      this.accounts.push(row);
      return row;
    }
    if (path === "/api/epg/sources/" && method === "POST") {
      const row = { ...body, id: this.nextId++ };
      this.epg.push(row);
      return row;
    }
    const m3uPatch = /^\/api\/m3u\/accounts\/(\d+)\/$/.exec(path);
    if (m3uPatch && method === "PATCH") return { ...body, id: Number(m3uPatch[1]) };
    const epgPatch = /^\/api\/epg\/sources\/(\d+)\/$/.exec(path);
    if (epgPatch && method === "PATCH") return { ...body, id: Number(epgPatch[1]) };
    if (/^\/api\/m3u\/refresh\/\d+\/$/.test(path) && method === "POST") return { success: true };
    if (path === "/api/epg/import/" && method === "POST") return { success: true };
    throw new Error(`unexpected request ${method} ${path}`);
  }
}

const state = {
  sources: [
    { id: "src_a", name: "Provider A - Line 1", enabled: true, maxStreams: 1, priority: 10 },
    { id: "src_b", name: "Provider B - Line 1", enabled: true, maxStreams: 2, priority: 20 },
  ],
};

test("Dispatcharr input preview creates one managed M3U per source plus canonical EPG", async () => {
  const client = new FakeClient();
  const result = await planDispatcharrInputs(state, { client });
  assert.equal(result.safe.counts["m3u:create"], 2);
  assert.equal(result.safe.counts["epg:create"], 1);
  assert.equal(result.safe.actions.some((row) => String(row.internalPath).includes("key=")), false);
  assert.ok(result.safe.actions.some((row) => row.internalPath === "/m3u/source/src_a.m3u"));
  assert.ok(result.safe.actions.some((row) => row.internalPath === "/epg/guide.xml"));
});

test("Dispatcharr input preview updates only JustOne-managed accounts and reports name conflicts", async () => {
  const client = new FakeClient({
    accounts: [
      {
        id: 7,
        name: "JustOne | Provider A - Line 1",
        server_url: "http://old/m3u.m3u",
        max_streams: 9,
        is_active: true,
        account_type: "STD",
        refresh_interval: 0,
        stale_stream_days: 7,
        priority: 10,
        custom_properties: { justone_managed: true, justone_role: "filtered_m3u", justone_source_id: "src_a" },
      },
      { id: 8, name: "JustOne | Provider B - Line 1", custom_properties: {} },
    ],
  });
  const result = await planDispatcharrInputs(state, { client });
  assert.ok(result.safe.actions.some((row) => row.type === "m3u" && row.action === "update" && row.sourceId === "src_a"));
  assert.ok(result.safe.actions.some((row) => row.type === "m3u" && row.action === "conflict" && row.sourceId === "src_b"));
});

test("provision apply creates inputs and queues M3U/EPG refresh jobs", async () => {
  const client = new FakeClient();
  const previous = process.env.DISPATCHARR_APPLY_ENABLED;
  // config is loaded before this test, so use preview-only function for mutation safety gate
  // and temporarily exercise the apply path by calling with a settings-compatible fake only
  // when repository config permits apply in the test environment.
  if (previous !== "true") {
    await assert.rejects(
      () => provisionDispatcharrInputs(state, { apply: true, refresh: true, client }),
      /apply is disabled/i,
    );
    return;
  }
  const result = await provisionDispatcharrInputs(state, { apply: true, refresh: true, client });
  assert.equal(result.refreshActions.filter((row) => row.type === "m3u-refresh").length, 2);
  assert.equal(result.refreshActions.filter((row) => row.type === "epg-refresh").length, 1);
});
