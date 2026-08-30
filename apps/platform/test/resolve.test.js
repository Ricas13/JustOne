import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mergeCandidates, validateCandidate } from "../src/resolve.js";

test("source candidates are deduplicated by URL and keep the existing resolver first at equal quality", () => {
  const rows = mergeCandidates(
    [
      { url: "https://media.example/a.mp4", quality: "1080p", provider: "existing" },
      { url: "https://media.example/low.mp4", quality: "720p", provider: "existing" },
    ],
    [
      { url: "https://media.example/a.mp4", name: "Source Resolver 1080p" },
      { url: "https://media.example/b.mp4", name: "Source Resolver 1080p" },
    ],
    "1080p",
  );

  assert.deepEqual(rows.map((row) => row.url), [
    "https://media.example/a.mp4",
    "https://media.example/b.mp4",
    "https://media.example/low.mp4",
  ]);
  assert.equal(rows[0].resolver, "primary");
  assert.equal(rows[1].resolver, "secondary");
});

test("validation tries HEAD first and falls back to a tiny ranged GET", async () => {
  const methods = [];
  const ranges = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    ranges.push(req.headers.range || "");
    if (req.method === "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 0-0/10" });
    res.end("x");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const ok = await validateCandidate({
      probeUrl: `http://127.0.0.1:${address.port}/video.mp4`,
      requestHeaders: { Referer: "https://example.test/" },
    });
    assert.equal(ok, true);
    assert.deepEqual(methods, ["HEAD", "GET"]);
    assert.equal(ranges[1], "bytes=0-0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
