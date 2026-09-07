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

test("individual DaddyLive family/embed/source candidates are qualified independently", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/primary/candidates/370") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        channel_id: "370",
        candidates: [
          { family: "stream", embed: 0, source: 0, id: "stream:0:0" },
          { family: "stream", embed: 0, source: 1, id: "stream:0:1" },
        ],
      }));
      return;
    }
    if (req.url === "/primary/candidate/370/stream/0/0.m3u8") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "candidate media probe failed" }));
      return;
    }
    if (req.url === "/primary/candidate/370/stream/0/1.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/hls/healthy.ts\n");
      return;
    }
    if (req.url === "/legacy/api/stream/370.m3u8") {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const picked = await resolveLive("370", {
      force: true,
      proxyUrl: `${base}/primary`,
      legacyUrl: `${base}/legacy`,
    });
    assert.equal(picked.provider, "daddy:stream:e1:s2");
    assert.equal(picked.playbackValidated, true);
    assert.deepEqual(picked.candidate, { family: "stream", embed: 0, source: 1 });
    assert.ok(hits.includes("/primary/candidate/370/stream/0/0.m3u8"));
    assert.ok(hits.includes("/primary/candidate/370/stream/0/1.m3u8"));
    assert.ok(hits.includes("/legacy/api/stream/370.m3u8"));
  } finally {
    await close(server);
  }
});
