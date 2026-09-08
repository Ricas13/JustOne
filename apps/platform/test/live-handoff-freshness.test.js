import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveLive } from "../src/resolve.js";

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

test("explicit in-session handoff freshly validates the stable aggregate before direct Daddy candidates", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/primary/candidates/455") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        channel_id: "455",
        candidates: [
          { family: "watch", embed: 0, source: 0 },
          { family: "stream", embed: 0, source: 0 },
        ],
      }));
      return;
    }
    if (req.url === "/primary/candidate/455/watch/0/0.m3u8") {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/primary/candidate/455/stream/0/0.m3u8") {
      res.writeHead(502).end();
      return;
    }
    if (req.url === "/primary/stream/455.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/primary/455.ts\n");
      return;
    }
    if (req.url === "/legacy/api/stream/455.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\n/legacy/media.m3u8\n");
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const failedLegacy = `${base}/legacy/api/stream/455.m3u8`;
  try {
    const picked = await resolveLive("455", {
      force: true,
      excludeUrl: failedLegacy,
      proxyUrl: `${base}/primary`,
      legacyUrl: `${base}/legacy`,
    });

    assert.equal(picked.provider, "amddeus-dlhd-proxy");
    assert.equal(picked.url, `${base}/primary/stream/455.m3u8`);
    assert.ok(hits.includes("/primary/candidates/455"), "candidate discovery still runs for learning/fallback");
    assert.ok(hits.includes("/primary/stream/455.m3u8"), "stable aggregate is freshly validated");
    assert.ok(!hits.includes("/legacy/api/stream/455.m3u8"), "failed root is hard-excluded");
    assert.ok(!hits.includes("/primary/candidate/455/watch/0/0.m3u8"), "stale direct candidate is not promoted ahead of a healthy stable root");
    assert.ok(!hits.includes("/primary/candidate/455/stream/0/0.m3u8"), "direct candidates are fallback-only during established-session handoff");
  } finally {
    await close(server);
  }
});

test("failed handoff qualification is briefly backed off instead of hammering every playlist request", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.url === "/primary/candidates/456") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        channel_id: "456",
        candidates: [{ family: "stream", embed: 0, source: 0 }],
      }));
      return;
    }
    if (req.url === "/primary/stream/456.m3u8") {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/primary/candidate/456/stream/0/0.m3u8") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const failedLegacy = `${base}/legacy/api/stream/456.m3u8`;
  const options = {
    force: true,
    excludeUrl: failedLegacy,
    proxyUrl: `${base}/primary`,
    legacyUrl: `${base}/legacy`,
  };

  try {
    await assert.rejects(resolveLive("456", options));
    const afterFirst = requests;
    assert.ok(afterFirst > 0);

    await assert.rejects(
      resolveLive("456", options),
      /cooling down/,
    );
    assert.equal(requests, afterFirst, "cooldown avoids another full candidate scan immediately");
  } finally {
    await close(server);
  }
});
