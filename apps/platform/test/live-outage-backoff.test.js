import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.LIVE_RESOLUTION_RETRY_BACKOFF_MS = "1000";
const { resolveLive } = await import("../src/resolve.js");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("repeated forced resolves back off after a full live-source outage", async () => {
  let discoveryRequests = 0;
  let primaryRequests = 0;
  let healthy = false;

  const server = http.createServer((req, res) => {
    if (req.url === "/primary/candidates/9719") {
      discoveryRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ channel_id: "9719", candidates: [] }));
      return;
    }
    if (req.url === "/primary/stream/9719.m3u8") {
      primaryRequests += 1;
      if (!healthy) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/primary/9719.ts\n");
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const options = {
    force: true,
    proxyUrl: `${base}/primary`,
    legacyUrl: "",
  };

  try {
    await assert.rejects(resolveLive("9719", options));
    assert.equal(discoveryRequests, 1);
    assert.equal(primaryRequests, 3, "initial aggregate probe still gets its bounded retries");

    await assert.rejects(
      resolveLive("9719", options),
      /live source resolution cooling down/,
    );
    assert.equal(discoveryRequests, 1, "cooldown avoids rediscovering the same dead candidates");
    assert.equal(primaryRequests, 3, "cooldown avoids another upstream retry burst");

    healthy = true;
    await sleep(1100);
    const picked = await resolveLive("9719", options);
    assert.equal(picked.provider, "amddeus-dlhd-proxy");
    assert.equal(discoveryRequests, 2, "one fresh qualification runs after the cooldown");
    assert.equal(primaryRequests, 4, "recovery succeeds on the first fresh upstream check");
  } finally {
    await close(server);
  }
});
