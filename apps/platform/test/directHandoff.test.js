import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { directHandoffEligible, resolveDirectHandoffTarget } from "../src/play.js";

const filename = "Example (2026) [tmdbid-1].m3u8";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("direct handoff only accepts safe movie/episode sources", () => {
  const providerUrl = "http://webstreamr-mbg:51546";
  const lazy = `${providerUrl}/%7B%22multi%22%3A%22on%22%7D/extract/?index=0&url=https%3A%2F%2Fexample.com`;

  assert.equal(
    directHandoffEligible(lazy, { filename, providerUrl, enabled: true }),
    true,
  );
  assert.equal(
    directHandoffEligible(lazy, {
      filename,
      providerUrl,
      enabled: true,
      upstreamHeaders: { referer: "https://example.com" },
    }),
    false,
  );
  assert.equal(
    directHandoffEligible(lazy, { filename, providerUrl, enabled: true, download: true }),
    false,
  );
  assert.equal(
    directHandoffEligible(lazy, { filename: null, providerUrl, enabled: true }),
    false,
  );
  assert.equal(
    directHandoffEligible("https://cdn.example/video.mp4", {
      filename,
      providerUrl,
      enabled: true,
    }),
    true,
  );
  assert.equal(
    directHandoffEligible(lazy, { filename, providerUrl, enabled: false }),
    false,
  );
});

test("lazy WebStreamr extract resolves only the external redirect", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "https://cdn.example/video/master.m3u8?token=abc" });
    res.end();
  });
  const address = await listen(server);
  const providerUrl = `http://127.0.0.1:${address.port}`;

  try {
    const target = await resolveDirectHandoffTarget(`${providerUrl}/config/extract/?index=0`, {
      filename,
      providerUrl,
      enabled: true,
      timeoutMs: 2000,
    });
    assert.equal(target, "https://cdn.example/video/master.m3u8?token=abc");
  } finally {
    await close(server);
  }
});

test("lazy extract never hands an internal redirect to the client", async () => {
  let providerUrl;
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: `${providerUrl}/still-internal` });
    res.end();
  });
  const address = await listen(server);
  providerUrl = `http://127.0.0.1:${address.port}`;

  try {
    const target = await resolveDirectHandoffTarget(`${providerUrl}/config/extract/?index=0`, {
      filename,
      providerUrl,
      enabled: true,
      timeoutMs: 2000,
    });
    assert.equal(target, null);
  } finally {
    await close(server);
  }
});

test("lazy extract rejects private-network handoff targets", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://192.168.1.10/video/master.m3u8" });
    res.end();
  });
  const address = await listen(server);
  const providerUrl = `http://127.0.0.1:${address.port}`;

  try {
    const target = await resolveDirectHandoffTarget(`${providerUrl}/config/extract/?index=0`, {
      filename,
      providerUrl,
      enabled: true,
      timeoutMs: 2000,
    });
    assert.equal(target, null);
  } finally {
    await close(server);
  }
});
