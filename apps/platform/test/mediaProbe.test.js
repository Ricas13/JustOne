import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { validatePlaybackMedia } from "../src/services/mediaProbe.js";

const PROBE_UA = "JustOne Live TV test";

function validateLiveCandidate(candidate) {
  return validatePlaybackMedia(candidate, Date.now() + 7000, 7000, PROBE_UA);
}

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

test("live media validation rejects HTTP 200 JSON error payloads", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.range, "bytes=0-0");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "channel unavailable" }));
  });
  const address = await listen(server);
  try {
    const ok = await validateLiveCandidate({
      probeUrl: `http://127.0.0.1:${address.port}/video.ts`,
      requestHeaders: {},
    });
    assert.equal(ok, false);
  } finally {
    await close(server);
  }
});

test("live media validation rejects an HLS manifest whose media segment is dead", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range || "" });
    if (req.url === "/master.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/segment.ts\n");
      return;
    }
    if (req.url === "/segment.ts") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    res.writeHead(404).end();
  });
  const address = await listen(server);
  try {
    const ok = await validateLiveCandidate({
      probeUrl: `http://127.0.0.1:${address.port}/master.m3u8`,
      requestHeaders: {},
    });
    assert.equal(ok, false);
    assert.equal(requests.filter((row) => row.path === "/master.m3u8").length, 2);
    assert.equal(requests.some((row) => row.path === "/segment.ts"), true);
  } finally {
    await close(server);
  }
});

test("live media validation accepts HLS only after a media segment returns bytes", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range || "" });
    if (req.url === "/master.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n/media.m3u8\n");
      return;
    }
    if (req.url === "/media.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/segment.ts\n");
      return;
    }
    if (req.url === "/segment.ts") {
      assert.equal(req.headers.range, "bytes=0-0");
      res.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 0-0/188",
      });
      res.end(Buffer.from([0x47]));
      return;
    }
    res.writeHead(404).end();
  });
  const address = await listen(server);
  try {
    const ok = await validateLiveCandidate({
      probeUrl: `http://127.0.0.1:${address.port}/master.m3u8`,
      requestHeaders: {},
    });
    assert.equal(ok, true);
    assert.equal(requests.some((row) => row.path === "/media.m3u8"), true);
    assert.equal(requests.some((row) => row.path === "/segment.ts"), true);
  } finally {
    await close(server);
  }
});
