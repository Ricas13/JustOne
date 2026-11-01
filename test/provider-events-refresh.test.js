import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// End-to-end: refreshCatalog() against local HTTP servers (DLHD 24/7 page + two
// provider playlists), exercising scan -> provider events -> outage -> expiry.
// config.js reads the environment at import time, so it is set up first; node --test
// runs each test file in its own process.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "justone-provider-events-"));
const routes = new Map();
const server = http.createServer((req, res) => {
  const route = routes.get(new URL(req.url, "http://x").pathname);
  if (!route) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(route.status || 200, { "content-type": route.type || "text/plain" });
  res.end(route.body || "");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.DATA_DIR = dataDir;
process.env.ADMIN_KEY = "test";
process.env.DLHD_BASE_URL = base;
process.env.DLHD_INCLUDE_SCHEDULE = "false";
process.env.DLHD_FAIL_CLOSED = "false";
process.env.PROVIDER_EVENT_TIMEZONE = "UTC";

const { refreshCatalog } = await import("../src/catalog.js");
const { loadSnapshot, saveSnapshot } = await import("../src/store.js");

const stamp = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
const playlistA = () => [
  "#EXTM3U",
  // tvg-name is generic: the event is only in the display name.
  `#EXTINF:-1 tvg-id="" tvg-name="PRIME US 007" group-title="AM | USA PPV-LIVE EVENTS",US| PRIME US 007 [Canelo vs. Mbilli (${stamp(60)})]`,
  "http://a.example/stream/1.ts",
  '#EXTINF:-1 tvg-id="" tvg-name="US| DAZN US 011 [EVENT ONLY]" group-title="AM | USA PPV-LIVE EVENTS",US| DAZN US 011 [EVENT ONLY]',
  "http://a.example/stream/2.ts",
].join("\n");
const playlistB = () => [
  "#EXTM3U",
  `#EXTINF:-1 tvg-id="" tvg-name="ES| DAZN 11 [Canelo vs Mbilli | Riyadh Season (${stamp(60)})]" group-title="EU | SPAIN DAZN",ES| DAZN 11 [Canelo vs Mbilli | Riyadh Season (${stamp(60)})]`,
  "http://b.example/stream/9.ts",
].join("\n");

before(() => {
  routes.set("/24-7-channels.php", {
    type: "text/html",
    body: '<a href="/watch.php?id=35"><div class="card__title">BBC One UK</div></a>',
  });
  const source = (id, name, file, priority) => ({ id, name, provider: name, account: "Line 1", maxStreams: 1, priority, url: `${base}/${file}`, enabled: true });
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    sources: [source("src_a", "provA", "a.m3u", 10), source("src_b", "provB", "b.m3u", 20)],
    guides: [], overrides: {}, aliases: {},
  }));
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const providerEvents = (snapshot) => (snapshot.channels || []).filter((c) => c.referenceKind === "event" && c.event?.source === "provider");
const urls = (channel) => channel.variants.map((v) => v.url).sort();

test("scan -> provider event: slots from two providers become one channel, placeholders are ignored", async () => {
  routes.set("/a.m3u", { body: playlistA() });
  routes.set("/b.m3u", { body: playlistB() });
  const snapshot = await refreshCatalog({ sourceMode: "auto" });
  const events = providerEvents(snapshot);
  assert.equal(events.length, 1, "one event channel for the Canelo slots, none for [EVENT ONLY]");
  assert.deepEqual(urls(events[0]), ["http://a.example/stream/1.ts", "http://b.example/stream/9.ts"]);
  assert.match(events[0].dlhdRefId, /^pevent-/);
  assert.ok(snapshot.providerEvents && Object.keys(snapshot.providerEvents).length > 1, "registry saved in the snapshot");
  assert.equal(snapshot.dlhdStatus.providerEvents.created, 1);
});

test("a source outage keeps its variant on a still-valid provider event, without duplicating the channel", async () => {
  fs.rmSync(path.join(dataDir, "provider-cache"), { recursive: true, force: true });
  routes.set("/a.m3u", { status: 500, body: "boom" });
  const snapshot = await refreshCatalog({ sourceMode: "auto" });
  assert.equal(snapshot.sourceStatus.find((s) => s.id === "src_a").ok, false);
  const events = providerEvents(snapshot);
  assert.equal(events.length, 1);
  assert.deepEqual(urls(events[0]), ["http://a.example/stream/1.ts", "http://b.example/stream/9.ts"]);
});

test("an expired event's variants from a failed source are not carried into the next occurrence", async () => {
  const saved = await loadSnapshot();
  const [channel] = providerEvents(saved);
  channel.event.start = Date.now() - 6 * 3_600_000;
  channel.event.end = Date.now() - 3 * 3_600_000; // window closed more than an hour ago
  await saveSnapshot(saved);

  fs.rmSync(path.join(dataDir, "provider-cache"), { recursive: true, force: true });
  routes.set("/a.m3u", { status: 500, body: "boom" });
  const snapshot = await refreshCatalog({ sourceMode: "auto" });
  const events = providerEvents(snapshot);
  assert.equal(events.length, 1);
  assert.deepEqual(urls(events[0]), ["http://b.example/stream/9.ts"], "provider A's old variant must not attach to the new occurrence");
});

test("when the source recovers its variant is simply the fresh one", async () => {
  fs.rmSync(path.join(dataDir, "provider-cache"), { recursive: true, force: true });
  routes.set("/a.m3u", { body: playlistA() });
  const events = providerEvents(await refreshCatalog({ sourceMode: "auto" }));
  assert.equal(events.length, 1);
  assert.deepEqual(urls(events[0]), ["http://a.example/stream/1.ts", "http://b.example/stream/9.ts"]);
});

test("a still-open window is not enough: an incompatible occurrence does not inherit a failed source's variant", async () => {
  const saved = await loadSnapshot();
  const [channel] = providerEvents(saved);
  // The remembered occurrence is still "open" (ends in the future) but starts a day after the current one.
  channel.event.start = Date.now() + 20 * 3_600_000;
  channel.event.end = channel.event.start + 3 * 3_600_000;
  channel.variants = [{ ...channel.variants[0], sourceId: "src_a", url: "http://a.example/stream/old.ts" }];
  await saveSnapshot(saved);

  fs.rmSync(path.join(dataDir, "provider-cache"), { recursive: true, force: true });
  routes.set("/a.m3u", { status: 500, body: "boom" });
  const events = providerEvents(await refreshCatalog({ sourceMode: "auto" }));
  assert.equal(events.length, 1);
  assert.deepEqual(urls(events[0]), ["http://b.example/stream/9.ts"]);
});
