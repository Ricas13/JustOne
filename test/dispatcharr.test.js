import test from "node:test";
import assert from "node:assert/strict";
import { planDispatcharrInputs, provisionDispatcharrInputs, rankFromName, reconcileDispatcharr } from "../src/dispatcharr.js";
import { config } from "../src/config.js";

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

class FakeReconcileClient {
  constructor({ channels = [], streams = [], groups = [], logos = [] } = {}) {
    this.channels = structuredClone(channels);
    this.streams = structuredClone(streams);
    this.groups = structuredClone(groups);
    this.logos = structuredClone(logos);
    this.calls = [];
  }
  async list(path) {
    if (path === "/api/channels/channels/") return this.channels;
    if (path.startsWith("/api/channels/streams/")) return this.streams;
    if (path === "/api/channels/groups/") return this.groups;
    if (path === "/api/channels/logos/") return this.logos;
    throw new Error(`unexpected list ${path}`);
  }
  async request(path, { method = "GET", body } = {}) {
    this.calls.push({ path, method, body });
    throw new Error(`unexpected request in preview ${method} ${path}`);
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

test("global channel policy allows foreign DLHD static references", async () => {
  const snapshot = {
    channels: [
      { referenceKind:"channel", tvgId:"justone.channel.bbc-one", name:"BBC One UK", group:"TV | UK", number:1000, variants:[{url:"x"}] },
      { referenceKind:"channel", tvgId:"justone.channel.eurosport-greece", name:"EuroSport 1 Greece", group:"TV | Greece", number:4000, variants:[{url:"y"}] },
    ],
  };
  const client = new FakeReconcileClient({
    streams: [
      { id:11, tvg_id:"justone.channel.bbc-one", name:"BBC One [JO:000]" },
      { id:12, tvg_id:"justone.channel.eurosport-greece", name:"Eurosport [JO:000]" },
    ],
    groups: [{ id:1, name:"TV | UK" }],
  });
  const result = await reconcileDispatcharr(snapshot, { apply:false, client });
  assert.equal(result.readyForApply, true);
  assert.equal(result.counts["policy-violation"] || 0, 0);
  assert.ok(result.actions.some((row) => row.action === "create" && row.tvgId === "justone.channel.eurosport-greece"));
});



test("an explicitly narrowed country policy still blocks foreign static references", async () => {
  const previous = [...(config.dlhd.staticCountries || [])];
  config.dlhd.staticCountries = ["GB", "PT", "US"];
  try {
    const snapshot = {
      channels: [
        { referenceKind:"channel", tvgId:"justone.channel.bbc-one", name:"BBC One UK", group:"TV | UK", number:1000, variants:[{url:"x"}] },
        { referenceKind:"channel", tvgId:"justone.channel.eurosport-greece", name:"EuroSport 1 Greece", group:"TV | Greece", number:4000, variants:[{url:"y"}] },
      ],
    };
    const client = new FakeReconcileClient({
      streams: [
        { id:11, tvg_id:"justone.channel.bbc-one", name:"BBC One [JO:000]" },
        { id:12, tvg_id:"justone.channel.eurosport-greece", name:"Eurosport [JO:000]" },
      ],
      groups: [{ id:1, name:"TV | UK" }],
    });
    const result = await reconcileDispatcharr(snapshot, { apply:false, client });
    assert.equal(result.readyForApply, false);
    assert.equal(result.counts["policy-violation"], 1);
    assert.ok(result.actions.some((row) => row.action === "policy-violation" && row.country === "GR"));
  } finally {
    config.dlhd.staticCountries = previous;
  }
});

test("channel preview is not ready while desired JustOne streams have not been imported", async () => {
  const snapshot = {
    channels: [
      { referenceKind:"event", tvgId:"justone.event.new-game", name:"New Game", group:"Events | Football", number:90000, variants:[{url:"x"}] },
    ],
  };
  const result = await reconcileDispatcharr(snapshot, { apply:false, client:new FakeReconcileClient() });
  assert.equal(result.readyForApply, false);
  assert.equal(result.counts["waiting-for-streams"], 1);
  assert.match(result.blockers.join(" "), /waiting for Dispatcharr stream import/i);
});

test("channel preview expires stale events but keeps unknown static orphans non-destructive", async () => {
  const snapshot = {
    channels: [
      { referenceKind:"event", tvgId:"justone.event.current", name:"Current Game", group:"Events | Football", number:90000, variants:[{url:"x"}] },
    ],
  };
  const client = new FakeReconcileClient({
    channels: [
      { id:21, tvg_id:"justone.event.old", name:"Old Game", streams:[31] },
      { id:22, tvg_id:"justone.channel.unknown", name:"Mystery Channel", streams:[32] },
      { id:23, tvg_id:"justone.channel.tnt-argentina", name:"TNT Sports Argentina", streams:[33] },
    ],
    streams: [{ id:30, tvg_id:"justone.event.current", name:"Current Game [JO:000]" }],
    groups: [{ id:1, name:"Events | Football" }],
  });
  const result = await reconcileDispatcharr(snapshot, { apply:false, client });
  assert.equal(result.readyForApply, true);
  assert.ok(result.actions.some((row) => row.action === "delete-stale-event" && row.id === 21));
  assert.ok(result.actions.some((row) => row.action === "orphan-static" && row.id === 22));
  assert.ok(result.actions.some((row) => row.action === "orphan-static" && row.id === 23));
  assert.equal(result.actions.some((row) => row.action === "delete-policy-static" && row.id === 23), false);
});
