import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { StreamManager } from "../src/stream-manager.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function tsChunk(label, packets = 3) {
  const fill = Buffer.from(String(label || "X"))[0] || 0x58;
  const out = Buffer.alloc(188 * packets, fill);
  for (let packet = 0; packet < packets; packet += 1) {
    out[packet * 188] = 0x47;
  }
  return out;
}
function liveHandler(label, stats, { endAfterFirst = false } = {}) {
  return (req, res) => {
    stats.requests = (stats.requests || 0) + 1;
    stats.active = (stats.active || 0) + 1;
    res.writeHead(200, { "content-type": "video/mp2t" });
    const chunk = tsChunk(label);
    res.write(chunk);
    if (endAfterFirst) {
      stats.active -= 1;
      return res.end();
    }
    const timer = setInterval(() => res.write(chunk), 20);
    const done = () => {
      clearInterval(timer);
      stats.active = Math.max(0, (stats.active || 1) - 1);
    };
    res.once("close", done);
  };
}
async function createHarness({ snapshot, state, upstreamHandler, options = {} }) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamBase = await listen(upstream);
  const hydrated = structuredClone(snapshot);
  for (const channel of hydrated.channels) {
    for (const variant of channel.variants) variant.url = variant.url.replace("UPSTREAM", upstreamBase);
  }
  const manager = new StreamManager({
    loadSnapshot: async () => hydrated,
    loadState: async () => structuredClone(state),
    options: {
      startupTimeoutMs: 1000,
      startupQueueTimeoutMs: 200,
      stallTimeoutMs: 800,
      relayGraceMs: 50,
      failoverWindowMs: 1200,
      failureCooldownMs: 100,
      sourceFailureCooldownMs: 100,
      notFoundCooldownMs: 100,
      startupBufferBytes: 188,
      replayBufferBytes: 188 * 8,
      failoverKeepaliveMs: 25,
      ...options,
    },
    logger: { warn() {}, error() {} },
  });
  const proxy = http.createServer((req, res) => {
    const match = /^\/stream\/([^/]+)\.ts$/.exec(new URL(req.url, "http://localhost").pathname);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    manager.handle(decodeURIComponent(match[1]), req, res);
  });
  const proxyBase = await listen(proxy);
  return {
    manager,
    upstream,
    proxy,
    proxyBase,
    async cleanup() {
      manager.shutdown();
      await close(proxy);
      await close(upstream);
    },
  };
}
async function openStream(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength > 0);
  return { response, reader, first: Buffer.from(first.value) };
}
async function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

test("two Jellyfin clients share one upstream connection for the same channel", async (t) => {
  const stats = {};
  const state = { sources: [{ id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true }] };
  const snapshot = { channels: [{ id: "bbc", tvgId: "justone.bbc", name: "BBC One", variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/live", quality: "HD" }] }] };
  const h = await createHarness({ snapshot, state, upstreamHandler: liveHandler("A", stats) });
  t.after(() => h.cleanup());

  const a = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  const b = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(stats.requests, 1);

  const status = await h.manager.status();
  assert.equal(status.activeRelays, 1);
  assert.equal(status.viewers, 2);
  assert.equal(status.upstreamConnections, 1);
  assert.equal(status.relays[0].provider, "Provider A");
  assert.equal(status.relays[0].account, "Account 1");
  assert.equal(status.relays[0].viewers, 2);
  assert.equal(status.relays[0].url, undefined);

  await a.reader.cancel();
  await b.reader.cancel();
});

test("maxStreams sends a different channel to the next free account", async (t) => {
  const one = {}, two = {};
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const variants = (suffix) => [
    { sourceId: "line1", order: 0, url: `UPSTREAM/one/${suffix}`, quality: "HD" },
    { sourceId: "line2", order: 1, url: `UPSTREAM/two/${suffix}`, quality: "HD" },
  ];
  const snapshot = { channels: [
    { id: "bbc", tvgId: "justone.bbc", name: "BBC One", variants: variants("bbc") },
    { id: "itv", tvgId: "justone.itv", name: "ITV1", variants: variants("itv") },
  ] };
  const handler = (req, res) => req.url.startsWith("/one/") ? liveHandler("1", one)(req, res) : liveHandler("2", two)(req, res);
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const a = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  const b = await openStream(`${h.proxyBase}/stream/itv.ts`);
  const status = await h.manager.status();
  const byChannel = new Map(status.relays.map((row) => [row.channelId, row.account]));

  assert.equal(byChannel.get("bbc"), "Account 1");
  assert.equal(byChannel.get("itv"), "Account 2");
  assert.equal(status.sources.find((row) => row.id === "line1").activeStreams, 1);
  assert.equal(status.sources.find((row) => row.id === "line2").activeStreams, 1);

  await a.reader.cancel();
  await b.reader.cancel();
});

test("startup failure is hidden from Jellyfin while the next account is tried", async (t) => {
  const good = {};
  const state = { sources: [
    { id: "bad", name: "Bad", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "good", name: "Good", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "bad", order: 0, url: "UPSTREAM/bad", quality: "HD" },
      { sourceId: "good", order: 1, url: "UPSTREAM/good", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => {
    if (req.url === "/bad") {
      res.writeHead(503).end("bad");
      return;
    }
    liveHandler("G", good)(req, res);
  };
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const stream = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  const status = await h.manager.status();
  assert.equal(status.relays[0].account, "Account 2");
  assert.equal(status.relays[0].attempts, 2);
  assert.ok(status.recentEvents.some((row) => row.type === "upstream-failure" && row.account === "Account 1"));
  await stream.reader.cancel();
});

test("mid-stream upstream end fails over without changing the Jellyfin URL", async (t) => {
  const second = {};
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "line1", order: 0, url: "UPSTREAM/first", quality: "HD" },
      { sourceId: "line2", order: 1, url: "UPSTREAM/second", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => req.url === "/first"
    ? liveHandler("A", {}, { endAfterFirst: true })(req, res)
    : liveHandler("B", second)(req, res);
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const response = await fetch(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let body = Buffer.alloc(0);
  await waitFor(async () => {
    const part = await reader.read();
    if (!part.done) body = Buffer.concat([body, Buffer.from(part.value)]);
    return body.includes(Buffer.from("BBBB"));
  });

  const status = await waitFor(async () => {
    const current = await h.manager.status();
    return current.relays[0]?.failovers >= 1 ? current : null;
  });
  assert.equal(status.relays[0].account, "Account 2");
  assert.equal(status.relays[0].failovers, 1);
  await reader.cancel();
});


test("source that dies before filling startup buffer is rejected before Jellyfin gets it", async (t) => {
  const good = {};
  const state = { sources: [
    { id: "short", name: "Short", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "good", name: "Good", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "short", order: 0, url: "UPSTREAM/short", quality: "HD" },
      { sourceId: "good", order: 1, url: "UPSTREAM/good", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => {
    if (req.url === "/short") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.end(tsChunk("S", 1));
      return;
    }
    liveHandler("G", good)(req, res);
  };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: { startupBufferBytes: 376 },
  });
  t.after(() => h.cleanup());

  const stream = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  const status = await h.manager.status();
  assert.equal(status.relays[0].account, "Account 2");
  assert.equal(status.relays[0].attempts, 2);
  assert.ok(status.recentEvents.some((row) =>
    row.type === "upstream-failure" &&
    row.account === "Account 1" &&
    row.message.includes("startup buffer")
  ));
  await stream.reader.cancel();
});

test("failover sends TS keepalives while replacement upstream is still starting", async (t) => {
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "line1", order: 0, url: "UPSTREAM/first", quality: "HD" },
      { sourceId: "line2", order: 1, url: "UPSTREAM/second", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => {
    if (req.url === "/first") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.write(tsChunk("A"));
      return setTimeout(() => res.end(), 40);
    }
    res.writeHead(200, { "content-type": "video/mp2t" });
    setTimeout(() => {
      res.write(tsChunk("B"));
      const timer = setInterval(() => res.write(tsChunk("B")), 20);
      res.once("close", () => clearInterval(timer));
    }, 300);
  };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: { startupBufferBytes: 188, failoverKeepaliveMs: 50, startupTimeoutMs: 1000 },
  });
  t.after(() => h.cleanup());

  const response = await fetch(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let body = Buffer.alloc(0);
  const seen = await waitFor(async () => {
    const part = await reader.read();
    if (!part.done) body = Buffer.concat([body, Buffer.from(part.value)]);
    const keepalive = body.includes(Buffer.from([0x47, 0x1f, 0xff]));
    const replacement = body.includes(Buffer.from("BBBB"));
    return keepalive && replacement;
  }, 2000);
  assert.equal(seen, true);

  const status = await h.manager.status();
  assert.equal(status.relays[0].account, "Account 2");
  assert.equal(status.relays[0].failovers, 1);
  await reader.cancel();
});


test("client disconnect during startup releases the provider slot promptly", async (t) => {
  let upstreamClosed = false;
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/slow", quality: "HD" }],
  }] };
  const handler = (req, res) => {
    res.writeHead(200, { "content-type": "video/mp2t" });
    res.flushHeaders();
    req.once("close", () => { upstreamClosed = true; });
  };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: { startupTimeoutMs: 2000, relayGraceMs: 40, startupBufferBytes: 188 },
  });
  t.after(() => h.cleanup());

  const request = http.get(`${h.proxyBase}/stream/bbc.ts`);
  request.on("error", () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  request.destroy();

  await waitFor(async () => {
    const status = await h.manager.status();
    return status.activeRelays === 0 && status.sources[0].activeStreams === 0 && upstreamClosed;
  }, 700);
});


test("idle grace yields a one-connection account immediately when a different channel is requested", async (t) => {
  const stats = { aClosed: false, bRequests: 0 };
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [
    { id: "a", tvgId: "justone.a", name: "Channel A", variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/a", quality: "HD" }] },
    { id: "b", tvgId: "justone.b", name: "Channel B", variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/b", quality: "HD" }] },
  ] };
  const handler = (req, res) => {
    res.writeHead(200, { "content-type": "video/mp2t" });
    const chunk = tsChunk(req.url === "/a" ? "A" : "B");
    res.write(chunk);
    const timer = setInterval(() => res.write(chunk), 20);
    if (req.url === "/b") stats.bRequests += 1;
    res.once("close", () => {
      clearInterval(timer);
      if (req.url === "/a") stats.aClosed = true;
    });
  };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: { relayGraceMs: 1000, startupQueueTimeoutMs: 600 },
  });
  t.after(() => h.cleanup());

  const a = await openStream(`${h.proxyBase}/stream/a.ts`);
  await a.reader.cancel();

  await waitFor(async () => {
    const status = await h.manager.status();
    return status.relays.some((row) => row.channelId === "a" && row.viewers === 0 && row.status === "grace");
  });

  const started = Date.now();
  const b = await openStream(`${h.proxyBase}/stream/b.ts`);
  assert.ok(Date.now() - started < 600, "new channel should not wait for the full idle grace period");
  assert.equal(stats.bRequests, 1);
  await waitFor(() => stats.aClosed);
  const status = await h.manager.status();
  assert.equal(status.sources[0].activeStreams, 1);
  assert.equal(status.relays.find((row) => row.channelId === "b")?.account, "Account 1");
  await b.reader.cancel();
});

test("failover window bounds slow replacement startup attempts", async (t) => {
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "line1", order: 0, url: "UPSTREAM/first", quality: "HD" },
      { sourceId: "line2", order: 1, url: "UPSTREAM/slow", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => {
    if (req.url === "/first") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.end(tsChunk("A"));
      return;
    }
    res.writeHead(200, { "content-type": "video/mp2t" });
    res.flushHeaders();
    // Deliberately never send media bytes; the failover budget must abort this attempt.
  };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: {
      startupBufferBytes: 188,
      startupTimeoutMs: 1200,
      failoverWindowMs: 180,
      failoverKeepaliveMs: 30,
    },
  });
  t.after(() => h.cleanup());

  const response = await fetch(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  const started = Date.now();
  const finalStatus = await waitFor(async () => {
    const status = await h.manager.status();
    return status.activeRelays === 0
      && status.recentEvents.some((row) => row.type === "failover-exhausted")
      ? status
      : null;
  }, 800);
  assert.ok(Date.now() - started < 700, "failover must respect the configured total window");
  assert.ok(finalStatus.recentEvents.some((row) => row.type === "upstream-failure" && row.account === "Account 2"));
  try { await reader.cancel(); } catch {}
});


test("a free account is preferred over preempting another channel's idle grace relay", async (t) => {
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const variants = (suffix) => [
    { sourceId: "line1", order: 0, url: `UPSTREAM/one/${suffix}`, quality: "HD" },
    { sourceId: "line2", order: 1, url: `UPSTREAM/two/${suffix}`, quality: "HD" },
  ];
  const snapshot = { channels: [
    { id: "a", tvgId: "justone.a", name: "Channel A", variants: variants("a") },
    { id: "b", tvgId: "justone.b", name: "Channel B", variants: variants("b") },
  ] };
  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: (req, res) => liveHandler(req.url.startsWith("/one/") ? "1" : "2", {})(req, res),
    options: { relayGraceMs: 1000, startupQueueTimeoutMs: 600 },
  });
  t.after(() => h.cleanup());

  const a = await openStream(`${h.proxyBase}/stream/a.ts`);
  await a.reader.cancel();
  await waitFor(async () => {
    const status = await h.manager.status();
    return status.relays.some((row) => row.channelId === "a" && row.status === "grace" && row.account === "Account 1");
  });

  const b = await openStream(`${h.proxyBase}/stream/b.ts`);
  const status = await h.manager.status();
  assert.equal(status.relays.find((row) => row.channelId === "b")?.account, "Account 2");
  assert.ok(status.relays.some((row) => row.channelId === "a" && row.status === "grace"));
  assert.equal(status.sources.find((row) => row.id === "line1").activeStreams, 1);
  assert.equal(status.sources.find((row) => row.id === "line2").activeStreams, 1);
  await b.reader.cancel();
});


test("media-looking garbage is rejected before Jellyfin receives HTTP 200", async (t) => {
  const state = { sources: [
    { id: "bad", name: "Bad", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "good", name: "Good", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "bad", order: 0, url: "UPSTREAM/bad", quality: "HD" },
      { sourceId: "good", order: 1, url: "UPSTREAM/good", quality: "HD" },
    ],
  }] };
  const handler = (req, res) => {
    res.writeHead(200, { "content-type": "video/mp2t" });
    if (req.url === "/bad") {
      res.end(Buffer.alloc(188 * 3, 0x41));
      return;
    }
    const chunk = tsChunk("G");
    res.write(chunk);
    const timer = setInterval(() => res.write(chunk), 20);
    res.once("close", () => clearInterval(timer));
  };
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const stream = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(stream.first[0], 0x47);
  const status = await h.manager.status();
  assert.equal(status.relays[0].account, "Account 2");
  assert.equal(status.relays[0].attempts, 2);
  assert.ok(status.recentEvents.some((row) =>
    row.type === "upstream-failure"
    && row.account === "Account 1"
    && row.message.includes("MPEG-TS sync")
  ));
  await stream.reader.cancel();
});


test("valid MPEG-TS is accepted even when a provider mislabels the content type", async (t) => {
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/live", quality: "HD" }],
  }] };
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = tsChunk("T");
    res.write(chunk);
    const timer = setInterval(() => res.write(chunk), 20);
    res.once("close", () => clearInterval(timer));
  };
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const stream = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  assert.equal(stream.response.headers.get("content-type"), "video/mp2t");
  assert.equal(stream.first[0], 0x47);
  await stream.reader.cancel();
});


test("viewer joining after failover receives replay only from the replacement source", async (t) => {
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [
      { sourceId: "line1", order: 0, url: "UPSTREAM/first", quality: "HD" },
      { sourceId: "line2", order: 1, url: "UPSTREAM/second", quality: "HD" },
    ],
  }] };

  const handler = (req, res) => {
    if (req.url === "/first") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.end(tsChunk("A"));
      return;
    }
    res.writeHead(200, { "content-type": "video/mp2t" });
    const chunk = tsChunk("B");
    res.write(chunk);
    const timer = setInterval(() => res.write(chunk), 20);
    res.once("close", () => clearInterval(timer));
  };

  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const firstViewer = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  await waitFor(async () => {
    const status = await h.manager.status();
    return status.relays[0]?.failovers === 1
      && status.relays[0]?.account === "Account 2";
  });

  const secondViewer = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  assert.ok(secondViewer.first.includes(Buffer.from("BBBB")));
  assert.equal(secondViewer.first.includes(Buffer.from("AAAA")), false);

  await firstViewer.reader.cancel();
  await secondViewer.reader.cancel();
});


test("simultaneous viewers joining during startup still create only one upstream relay", async (t) => {
  const stats = { requests: 0 };
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/live", quality: "HD" }],
  }] };
  const handler = (_req, res) => {
    stats.requests += 1;
    res.writeHead(200, { "content-type": "video/mp2t" });
    setTimeout(() => {
      const chunk = tsChunk("S");
      res.write(chunk);
      const timer = setInterval(() => res.write(chunk), 20);
      res.once("close", () => clearInterval(timer));
    }, 120);
  };
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const [a, b] = await Promise.all([
    openStream(`${h.proxyBase}/stream/bbc.ts`),
    openStream(`${h.proxyBase}/stream/bbc.ts`),
  ]);

  assert.equal(stats.requests, 1);
  const status = await h.manager.status();
  assert.equal(status.activeRelays, 1);
  assert.equal(status.viewers, 2);
  assert.equal(status.upstreamConnections, 1);

  await a.reader.cancel();
  await b.reader.cancel();
});

test("simultaneous different channels cannot race past maxStreams", async (t) => {
  const stats = { line1: 0, line2: 0 };
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
    { id: "line2", name: "Line 2", provider: "Provider A", account: "Account 2", maxStreams: 1, enabled: true },
  ] };
  const variants = (suffix) => [
    { sourceId: "line1", order: 0, url: `UPSTREAM/one/${suffix}`, quality: "HD" },
    { sourceId: "line2", order: 1, url: `UPSTREAM/two/${suffix}`, quality: "HD" },
  ];
  const snapshot = { channels: [
    { id: "a", tvgId: "justone.a", name: "Channel A", variants: variants("a") },
    { id: "b", tvgId: "justone.b", name: "Channel B", variants: variants("b") },
  ] };
  const handler = (req, res) => {
    if (req.url.startsWith("/one/")) stats.line1 += 1;
    else stats.line2 += 1;
    res.writeHead(200, { "content-type": "video/mp2t" });
    setTimeout(() => {
      const chunk = tsChunk(req.url.startsWith("/one/") ? "1" : "2");
      res.write(chunk);
      const timer = setInterval(() => res.write(chunk), 20);
      res.once("close", () => clearInterval(timer));
    }, 100);
  };
  const h = await createHarness({ snapshot, state, upstreamHandler: handler });
  t.after(() => h.cleanup());

  const [a, b] = await Promise.all([
    openStream(`${h.proxyBase}/stream/a.ts`),
    openStream(`${h.proxyBase}/stream/b.ts`),
  ]);

  const status = await h.manager.status();
  assert.equal(status.upstreamConnections, 2);
  assert.equal(status.sources.find((row) => row.id === "line1").activeStreams, 1);
  assert.equal(status.sources.find((row) => row.id === "line2").activeStreams, 1);
  assert.equal(stats.line1, 1);
  assert.equal(stats.line2, 1);

  await a.reader.cancel();
  await b.reader.cancel();
});


test("Jellyfin reconnect during failover reuses the same relay within grace", async (t) => {
  let requests = 0;
  const state = { sources: [
    { id: "line1", name: "Line 1", provider: "Provider A", account: "Account 1", maxStreams: 1, enabled: true },
  ] };
  const snapshot = { channels: [{
    id: "bbc", tvgId: "justone.bbc", name: "BBC One",
    variants: [{ sourceId: "line1", order: 0, url: "UPSTREAM/live", quality: "HD" }],
  }] };

  const handler = (_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "video/mp2t" });
    if (requests === 1) {
      res.end(tsChunk("A"));
      return;
    }
    const chunk = tsChunk("B");
    res.write(chunk);
    const timer = setInterval(() => res.write(chunk), 20);
    res.once("close", () => clearInterval(timer));
  };

  const h = await createHarness({
    snapshot,
    state,
    upstreamHandler: handler,
    options: {
      failureCooldownMs: 180,
      relayGraceMs: 700,
      failoverWindowMs: 900,
      failoverKeepaliveMs: 30,
    },
  });
  t.after(() => h.cleanup());

  const first = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  await waitFor(async () => {
    const status = await h.manager.status();
    return status.relays[0]?.status === "failover";
  });
  await first.reader.cancel();

  await new Promise((resolve) => setTimeout(resolve, 60));
  const duringGrace = await h.manager.status();
  assert.equal(duringGrace.activeRelays, 1);
  assert.equal(duringGrace.relays[0].viewers, 0);

  const second = await openStream(`${h.proxyBase}/stream/bbc.ts`);
  await waitFor(async () => {
    const status = await h.manager.status();
    return status.relays[0]?.failovers === 1 ? status : null;
  });

  const finalStatus = await h.manager.status();
  assert.equal(requests, 2);
  assert.equal(finalStatus.relays[0].attempts, 2);
  assert.equal(finalStatus.relays[0].failovers, 1);
  assert.equal(
    finalStatus.recentEvents.filter((row) => row.type === "started" && row.channelId === "bbc").length,
    1
  );

  await second.reader.cancel();
});
