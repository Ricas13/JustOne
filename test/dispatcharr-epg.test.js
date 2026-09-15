import test from "node:test";
import assert from "node:assert/strict";
import { reconcileDispatcharr } from "../src/dispatcharr-epg.js";

class FakeClient {
  constructor({ channels = [], streams = [], groups = [], logos = [], epgSources = [], epgData = [] } = {}) {
    this.channels = structuredClone(channels);
    this.streams = structuredClone(streams);
    this.groups = structuredClone(groups);
    this.logos = structuredClone(logos);
    this.epgSources = structuredClone(epgSources);
    this.epgData = structuredClone(epgData);
    this.calls = [];
  }
  async list(path) {
    if (path === "/api/channels/channels/") return this.channels;
    if (path.startsWith("/api/channels/streams/")) return this.streams;
    if (path === "/api/channels/groups/") return this.groups;
    if (path === "/api/channels/logos/") return this.logos;
    if (path === "/api/epg/sources/") return this.epgSources;
    if (path === "/api/epg/epgdata/") return this.epgData;
    throw new Error(`unexpected list ${path}`);
  }
  async request(path, { method = "GET", body } = {}) {
    this.calls.push({ path, method, body });
    throw new Error(`unexpected request in preview ${method} ${path}`);
  }
}

const snapshot = {
  channels: [
    {
      referenceKind: "channel",
      tvgId: "justone.channel.bbc-one",
      name: "BBC One UK",
      group: "TV | UK",
      number: 1000,
      logo: "",
      variants: [{ url: "x" }],
    },
  ],
};

const canonicalSource = {
  id: 10,
  name: "JustOne | Canonical EPG",
  custom_properties: { justone_managed: true, justone_role: "canonical_epg" },
};

test("Dispatcharr preview explicitly maps channel to matching canonical EPG entry", async () => {
  const client = new FakeClient({
    channels: [
      {
        id: 21,
        tvg_id: "justone.channel.bbc-one",
        name: "BBC One UK",
        channel_number: 1000,
        channel_group_id: 1,
        streams: [31],
        epg_data_id: null,
      },
    ],
    streams: [{ id: 31, tvg_id: "justone.channel.bbc-one", name: "BBC One [JO:000]" }],
    groups: [{ id: 1, name: "TV | UK" }],
    epgSources: [canonicalSource],
    epgData: [
      { id: 501, tvg_id: "justone.channel.bbc-one", name: "BBC One UK", epg_source: 10 },
      { id: 777, tvg_id: "justone.channel.bbc-one", name: "Wrong source", epg_source: 99 },
    ],
  });

  const result = await reconcileDispatcharr(snapshot, { apply: false, client });
  assert.equal(result.readyForApply, true);
  assert.equal(result.epg.sourceId, 10);
  assert.equal(result.epg.availableEntries, 1);
  assert.equal(result.epg.mappedDesired, 1);
  assert.ok(result.actions.some((row) => row.action === "map-epg" && row.epgDataId === 501));
});

test("Dispatcharr preview blocks apply until every desired channel exists in canonical EPG", async () => {
  const client = new FakeClient({
    streams: [{ id: 31, tvg_id: "justone.channel.bbc-one", name: "BBC One [JO:000]" }],
    groups: [{ id: 1, name: "TV | UK" }],
    epgSources: [canonicalSource],
    epgData: [],
  });

  const result = await reconcileDispatcharr(snapshot, { apply: false, client });
  assert.equal(result.readyForApply, false);
  assert.equal(result.counts["waiting-for-epg"], 1);
  assert.match(result.blockers.join(" "), /missing from JustOne \| Canonical EPG/i);
});
