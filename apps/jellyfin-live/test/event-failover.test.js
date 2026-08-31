import test from "node:test";
import assert from "node:assert/strict";
import {
  clearEventWinnerCache,
  collapseSportsEvents,
  eventDisplayTitle,
  probeUrlForCandidate,
  qualityRank,
  selectWorkingEventCandidate,
} from "../src/event-failover.js";

const rawUrl = (id) => `https://resolver.vpn4u.cc/play/live/${id}.ts?key=exact-${id}`;

function event(id, name, url, number = 1000, group = "Sports | Football") {
  return {
    id,
    tvgId: `justone.${id}`,
    sourceTvgIds: [`dlhd-${id}`],
    kind: "sport-slot",
    eventStyle: true,
    name,
    group,
    number,
    url,
    candidates: [{ url, label: name }],
    programmes: [{ start: 1, end: 2, title: name }],
  };
}

test("duplicate sports event rows collapse to one selector while retaining every original URL", () => {
  const fourK = rawUrl("4k");
  const hd = rawUrl("hd");
  const sd = rawUrl("sd");
  const bbc = rawUrl("bbc");

  const input = [
    event("sd", "England - Premier League : Chelsea vs Brighton - Event SD Stream", sd, 1001),
    event("hd", "England - Premier League : Chelsea vs Brighton - TNT Sports 1 HD", hd, 1002),
    event("4k", "England - Premier League : Chelsea vs Brighton - Sky Sports UHD", fourK, 1003),
    { id: "bbc", kind: "static", name: "BBC One", group: "TV | UK", url: bbc, candidates: [{ url: bbc, label: "BBC One" }] },
  ];

  const out = collapseSportsEvents(input);
  assert.equal(out.length, 2);
  const merged = out.find((row) => row.kind === "sport-slot");
  assert.equal(merged.name, "England - Premier League : Chelsea vs Brighton");
  assert.equal(merged.eventFailover, true);
  assert.equal(merged.sourceCount, 3);
  assert.match(merged.url, /\/jellyfin\/event\/event\.[a-f0-9]+\.ts/);
  assert.deepEqual(merged.candidates.map((row) => row.url), [fourK, hd, sd]);
  assert.deepEqual(merged.candidates.map((row) => row.quality), ["4K/UHD", "HD/720p", "SD/480p"]);
  assert.equal(out.find((row) => row.id === "bbc").url, bbc, "ordinary channels remain direct");
});

test("all broadcaster variants of the same fixture collapse even when broadcaster names are unfamiliar", () => {
  const names = [
    "England - Premier League : Chelsea vs Brighton & Hove Albion",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - Astro Grandstand",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - Canal+ Extra 1 Poland",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - Cytavision Sports 3 Cyprus",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - Hub Premier 4",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - Nova Sports Premier League Greece",
    "England - Premier League : Chelsea vs Brighton & Hove Albion - USA Network",
  ];
  const out = collapseSportsEvents(names.map((name, index) => event(`real-${index}`, name, rawUrl(`real-${index}`), 1000 + index)));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "England - Premier League : Chelsea vs Brighton & Hove Albion");
  assert.equal(out[0].sourceCount, names.length);
  assert.deepEqual(new Set(out[0].candidates.map((row) => row.url)).size, names.length);
});

test("non-head-to-head race variants collapse only when the final tail is a broadcaster", () => {
  const names = [
    "MotoGP : Aragon Race",
    "MotoGP : Aragon Race - Arena Adrenalin",
    "MotoGP : Aragon Race - Canal+",
    "MotoGP : Aragon Race - Cosmote Sport 5 Greece",
    "MotoGP : Aragon Race - Sky Sport MotoGP",
    "MotoGP : Aragon Race - Sport TV4",
  ];
  const out = collapseSportsEvents(names.map((name, index) => event(`moto-${index}`, name, rawUrl(`moto-${index}`), 2000 + index, "Sports | Motorsport")));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "MotoGP : Aragon Race");
  assert.equal(out[0].sourceCount, names.length);

  assert.equal(eventDisplayTitle("Formula 1 - British Grand Prix"), "Formula 1 - British Grand Prix");
});

test("single-source sports events retain their original playback URL", () => {
  const url = rawUrl("single");
  const [out] = collapseSportsEvents([
    event("single", "Arsenal vs Chelsea - Sky Sports Football HD", url),
  ]);
  assert.equal(out.url, url);
  assert.equal(out.eventFailover, undefined);
});

test("similar but different fixtures are not collapsed", () => {
  const out = collapseSportsEvents([
    event("a", "England - Premier League : Arsenal vs Chelsea - Sky Sports HD", rawUrl("a")),
    event("b", "England - Premier League : Arsenal vs Liverpool - Sky Sports HD", rawUrl("b")),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((row) => row.url), [rawUrl("a"), rawUrl("b")]);
});

test("event title removes only the final source suffix", () => {
  assert.equal(
    eventDisplayTitle("Spain - La Liga : Celta de Vigo vs Athletic Club - beIN Sports MENA 3"),
    "Spain - La Liga : Celta de Vigo vs Athletic Club",
  );
  assert.equal(
    eventDisplayTitle("ATP - Singles: Aleksandar Vukic vs Rei Sakamoto - Tennis Stream"),
    "ATP - Singles: Aleksandar Vukic vs Rei Sakamoto",
  );
  assert.equal(
    eventDisplayTitle("Brazil - Brasileirão : Mirassol vs Palmeiras - Premiere"),
    "Brazil - Brasileirão : Mirassol vs Palmeiras",
  );
});

test("quality ranking is highest quality to lowest quality", () => {
  assert.ok(qualityRank("Sky Sports UHD") > qualityRank("Sky Sports FHD"));
  assert.ok(qualityRank("Sky Sports FHD") > qualityRank("Sky Sports HD"));
  assert.ok(qualityRank("Sky Sports HD") > qualityRank("Sky Sports"));
  assert.ok(qualityRank("Sky Sports") > qualityRank("Event SD Stream"));
});

test("selector probes highest quality first and returns the exact original working URL", async () => {
  clearEventWinnerCache();
  const fourK = rawUrl("401");
  const hd = rawUrl("402");
  const sd = rawUrl("403");
  const [channel] = collapseSportsEvents([
    event("sd", "Chelsea vs Brighton - Event SD Stream", sd),
    event("hd", "Chelsea vs Brighton - TNT Sports 1 HD", hd),
    event("4k", "Chelsea vs Brighton - Sky Sports UHD", fourK),
  ]);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("401.m3u8")) return new Response("bad", { status: 502 });
    if (url.includes("402.m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-VERSION:3\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    throw new Error("lower quality source should not be probed after HD succeeds");
  };

  const selected = await selectWorkingEventCandidate(channel, { fetchImpl, timeoutMs: 1000 });
  assert.equal(selected.url, hd, "the exact original .ts playback URL is returned");
  assert.deepEqual(calls, [probeUrlForCandidate(fourK), probeUrlForCandidate(hd)]);
  assert.match(calls[0], /\/play\/live\/401\.m3u8\?key=exact-401$/);
  assert.match(calls[1], /\/play\/live\/402\.m3u8\?key=exact-402$/);
});

test("selector returns null when no candidate can be validated", async () => {
  clearEventWinnerCache();
  const [channel] = collapseSportsEvents([
    event("a", "Chelsea vs Brighton - Sky Sports UHD", rawUrl("a")),
    event("b", "Chelsea vs Brighton - Event SD Stream", rawUrl("b")),
  ]);
  const fetchImpl = async () => new Response("<html>not a stream</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  assert.equal(await selectWorkingEventCandidate(channel, { fetchImpl, timeoutMs: 1000 }), null);
});
