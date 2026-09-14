import test from "node:test";
import assert from "node:assert/strict";
import { providerOrderForChannel, providerOrderKey } from "../src/provider-order.js";
import { finalizeSnapshot } from "../src/finalize.js";

function order(position, provider = "Test Provider") {
  return { position, provider, source:"test", matchedName:"test" };
}

function providerOrders() {
  return {
    countries: {
      GB: new Map([
        [providerOrderKey("BBC One HD"), order(101, "Sky TV UK")],
        [providerOrderKey("BBC Four HD"), order(119, "Sky TV UK")],
        [providerOrderKey("TNT Sports 1 HD"), order(413, "Sky TV UK")],
      ]),
      PT: new Map([
        [providerOrderKey("RTP 1"), order(1, "MEO")],
        [providerOrderKey("TVI"), order(4, "MEO")],
        [providerOrderKey("DAZN 1"), order(33, "MEO")],
      ]),
      US: new Map([
        [providerOrderKey("WABC"), order(7, "DIRECTV + NYC locals")],
        [providerOrderKey("CNN"), order(202, "DIRECTV Premier")],
        [providerOrderKey("ESPN"), order(206, "DIRECTV Premier")],
      ]),
    },
    metadata: {
      GB:{ provider:"Sky TV UK", source:"test" },
      PT:{ provider:"MEO", source:"test" },
      US:{ provider:"DIRECTV Premier + NYC locals", source:"test" },
    },
  };
}

function channel(id, name, group, aliasNames = []) {
  return {
    id,
    key:id,
    tvgId:`justone.${id}`,
    name,
    group,
    referenceKind:"channel",
    dlhdRefId:`ref-${id}`,
    aliasNames,
    variants:[{ sourceId:"a", url:`http://a/${id}`, name:"HD", quality:"HD", backup:false, order:0 }],
  };
}

test("provider-order normalization ignores quality and number words", () => {
  assert.equal(providerOrderKey("UK| BBC Four HD"), providerOrderKey("BBC 4"));
  assert.equal(providerOrderKey("US| ESPN FHD"), providerOrderKey("ESPN"));
});

test("provider order can resolve aliases rather than only canonical names", () => {
  const orders = providerOrders();
  const hit = providerOrderForChannel(
    channel("abc", "ABC NY USA", "TV | USA", ["WABC 7 HD", "ABC 7 New York"]),
    orders,
  );
  assert.equal(hit.position, 7);
  assert.equal(hit.provider, "DIRECTV + NYC locals");
});

test("finalizer keeps UK PT USA blocks but orders each by its TV provider", () => {
  const snapshot = {
    channels: [
      channel("tnt", "TNT Sports 1 UK", "TV | GB"),
      channel("bbc4", "BBC Four UK", "TV | GB"),
      channel("bbc1", "BBC One UK", "TV | GB"),
      channel("dazn", "DAZN 1 Portugal", "TV | PT"),
      channel("tvi", "TVI Portugal", "TV | PT"),
      channel("rtp", "RTP 1 Portugal", "TV | PT"),
      channel("espn", "ESPN USA", "TV | US"),
      channel("cnn", "CNN USA", "TV | US"),
      channel("abc", "ABC NY USA", "TV | US", ["WABC"]),
      channel("unknown", "Zulu Channel USA", "TV | US"),
    ],
    dlhdReference:{ channels:[], events:[] },
    dlhdStatus:{ unmatchedReferences:[], outputMappings:10 },
  };

  const { snapshot: result } = finalizeSnapshot(snapshot, { overrides:{} }, { providerOrders:providerOrders() });

  assert.deepEqual(result.channels.map((x)=>x.id), [
    "bbc1", "bbc4", "tnt",
    "rtp", "tvi", "dazn",
    "abc", "cnn", "espn", "unknown",
  ]);
  assert.deepEqual(result.channels.map((x)=>x.number), [1000,1001,1002,2000,2001,2002,3000,3001,3002,3003]);
  assert.equal(result.channels.at(-1).providerOrder, undefined);
  assert.deepEqual(result.lineupOrdering.UK, { provider:"Sky TV UK", source:"test", matched:3, unmatched:0, total:3 });
  assert.deepEqual(result.lineupOrdering.PT, { provider:"MEO", source:"test", matched:3, unmatched:0, total:3 });
  assert.deepEqual(result.lineupOrdering.USA, { provider:"DIRECTV Premier + NYC locals", source:"test", matched:3, unmatched:1, total:4 });
});
