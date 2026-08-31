import test from "node:test";
import assert from "node:assert/strict";
import {
  iptvOrgFetchComplete,
  iptvOrgSnapshotReady,
  mergeIptvOrgSnapshot,
} from "../src/iptv-org-cache.js";

test("partial IPTV-org refresh preserves last-good logos", () => {
  const previous = {
    channels: [{ id: "BBCOne.uk" }],
    logos: [{ channel: "BBCOne.uk", url: "https://example/logo.png" }],
    guides: [{ channel: "BBCOne.uk" }],
  };

  const fetched = {
    channels: [{ id: "BBCOne.uk" }, { id: "BBCtwo.uk" }],
    logos: null,
    guides: [{ channel: "BBCOne.uk" }, { channel: "BBCtwo.uk" }],
  };

  const result = mergeIptvOrgSnapshot(previous, fetched);
  assert.deepEqual(result.next.logos, previous.logos);
  assert.deepEqual(result.reused, ["logos"]);
  assert.deepEqual(result.missing, []);
  assert.equal(iptvOrgSnapshotReady(result.next), true);
  assert.equal(iptvOrgFetchComplete(fetched), false);
});

test("cold partial IPTV-org refresh stays incomplete instead of looking healthy", () => {
  const fetched = {
    channels: [{ id: "BBCOne.uk" }],
    logos: [],
    guides: [{ channel: "BBCOne.uk" }],
  };

  const result = mergeIptvOrgSnapshot({}, fetched);
  assert.deepEqual(result.next.logos, []);
  assert.deepEqual(result.missing, ["logos"]);
  assert.equal(iptvOrgSnapshotReady(result.next), false);
  assert.equal(iptvOrgFetchComplete(fetched), false);
});
