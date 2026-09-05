import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { liveStreamEndpoints, resolveLive } from "../src/resolve.js";

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

test("amddeus DLHD proxy is preferred while legacy resolver remains fallback", () => {
  assert.deepEqual(
    liveStreamEndpoints("123.ts", {
      proxyUrl: "http://dlhd-proxy:3000/",
      legacyUrl: "http://dlhd:3000/",
    }),
    [
      { provider: "amddeus-dlhd-proxy", url: "http://dlhd-proxy:3000/stream/123.m3u8" },
      { provider: "legacy-dlhd-web", url: "http://dlhd:3000/api/stream/123.m3u8" },
    ],
  );
});

test("legacy DLHD remains usable when the new proxy is not configured", () => {
  assert.deepEqual(
    liveStreamEndpoints("44.m3u8", { proxyUrl: "", legacyUrl: "http://dlhd:3000" }),
    [{ provider: "legacy-dlhd-web", url: "http://dlhd:3000/api/stream/44.m3u8" }],
  );
});

test("cold tune accepts a real HLS manifest without a second segment probe", async () => {
  let manifestRequests = 0;
  let mediaProbes = 0;
  let legacyRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/149.m3u8") {
      manifestRequests += 1;
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/primary/dead.ts\n");
      return;
    }
    if (req.url === "/primary/dead.ts") {
      mediaProbes += 1;
      res.writeHead(503).end();
      return;
    }
    if (req.url.startsWith("/legacy/")) {
      legacyRequests += 1;
      res.writeHead(500).end();
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const picked = await resolveLive("149", {
      force: true,
      proxyUrl: `${base}/primary`,
      legacyUrl: `${base}/legacy`,
    });
    assert.equal(picked.provider, "amddeus-dlhd-proxy");
    assert.equal(picked.playbackValidated, false);
    assert.equal(picked.liveValidated, true);
    assert.equal(manifestRequests, 1);
    assert.equal(mediaProbes, 0);
    assert.equal(legacyRequests, 0);
  } finally {
    await close(server);
  }
});

test("HTTP-200 error payload is rejected and operationally falls back to legacy", async () => {
  let legacyRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/150.m3u8") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "channel unavailable" }));
      return;
    }
    if (req.url === "/legacy/api/stream/150.m3u8") {
      legacyRequests += 1;
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXTINF:2,\n/legacy/150.ts\n");
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const picked = await resolveLive("150", {
      force: true,
      proxyUrl: `${base}/primary`,
      legacyUrl: `${base}/legacy`,
    });
    assert.equal(picked.provider, "legacy-dlhd-web");
    assert.equal(picked.playbackValidated, false);
    assert.equal(legacyRequests, 1);
  } finally {
    await close(server);
  }
});

test("primary 404 is authoritative and does not double tune latency with legacy", async () => {
  let legacyRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/722.m3u8") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "stream unavailable" }));
      return;
    }
    if (req.url.startsWith("/legacy/")) {
      legacyRequests += 1;
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXTINF:2,\n/legacy/722.ts\n");
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      resolveLive("722", {
        force: true,
        proxyUrl: `${base}/primary`,
        legacyUrl: `${base}/legacy`,
      }),
      /returned 404/,
    );
    assert.equal(legacyRequests, 0);
  } finally {
    await close(server);
  }
});

test("concurrent live resolves for one channel share one manifest admission", async () => {
  let manifestRequests = 0;
  let mediaProbes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/151.m3u8") {
      manifestRequests += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/primary/151.ts\n");
      }, 75);
      return;
    }
    if (req.url === "/primary/151.ts") {
      mediaProbes += 1;
      res.writeHead(206, { "content-type": "video/mp2t" });
      res.end(Buffer.from([0x47]));
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const options = {
      force: true,
      proxyUrl: `${base}/primary`,
      legacyUrl: "",
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => resolveLive("151", options)),
    );
    assert.ok(results.every((picked) => picked.provider === "amddeus-dlhd-proxy"));
    assert.equal(manifestRequests, 1);
    assert.equal(mediaProbes, 0);
  } finally {
    await close(server);
  }
});

test("recent successful resolve is reused without another upstream request", async () => {
  let manifestRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/153.m3u8") {
      manifestRequests += 1;
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXTINF:2,\n/primary/153.ts\n");
      return;
    }
    res.writeHead(404).end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const options = { proxyUrl: `${base}/primary`, legacyUrl: "" };
    const first = await resolveLive("153", options);
    const second = await resolveLive("153", options);
    assert.equal(first.url, second.url);
    assert.equal(manifestRequests, 1);
  } finally {
    await close(server);
  }
});
