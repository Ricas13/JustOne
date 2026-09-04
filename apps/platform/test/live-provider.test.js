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

test("live resolver rejects a manifest with dead media and falls back to legacy", async () => {
  let primaryMediaProbes = 0;
  let legacyMediaProbes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/149.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/primary/dead.ts\n");
      return;
    }
    if (req.url === "/primary/dead.ts") {
      primaryMediaProbes += 1;
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("upstream unavailable");
      return;
    }
    if (req.url === "/legacy/api/stream/149.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/legacy/good.ts\n");
      return;
    }
    if (req.url === "/legacy/good.ts") {
      legacyMediaProbes += 1;
      res.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 0-0/188",
      });
      res.end(Buffer.from([0x47]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const picked = await resolveLive("149", {
      force: true,
      proxyUrl: `${base}/primary`,
      legacyUrl: `${base}/legacy`,
    });
    assert.equal(picked.provider, "legacy-dlhd-web");
    assert.equal(picked.playbackValidated, true);
    assert.equal(picked.liveValidated, true);
    assert.ok(primaryMediaProbes >= 1);
    assert.ok(legacyMediaProbes >= 1);
  } finally {
    await close(server);
  }
});

test("live resolver does not accept an HTTP-200 error payload as a working channel", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/primary/stream/150.m3u8") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "channel unavailable" }));
      return;
    }
    if (req.url === "/legacy/api/stream/150.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXTINF:2,\n/legacy/150.ts\n");
      return;
    }
    if (req.url === "/legacy/150.ts") {
      res.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 0-0/188",
      });
      res.end(Buffer.from([0x47]));
      return;
    }
    res.writeHead(404);
    res.end();
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
    assert.equal(picked.playbackValidated, true);
  } finally {
    await close(server);
  }
});

test("concurrent live resolves for one channel share one upstream probe", async () => {
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
      res.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 0-0/188",
      });
      res.end(Buffer.from([0x47]));
      return;
    }
    res.writeHead(404);
    res.end();
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
    // The media probe is the expensive validation that must be shared. The
    // validator may fetch the manifest more than once while walking HLS, so do
    // not couple this regression to that implementation detail.
    assert.equal(mediaProbes, 1);
    assert.ok(manifestRequests >= 1 && manifestRequests <= 3);
  } finally {
    await close(server);
  }
});
