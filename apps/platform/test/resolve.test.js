import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mergeCandidates,
  validateCandidate,
  validateCandidateForPlayback,
  checkMovieAvailability,
  pickSource,
  resolveMovie,
  suppressSource,
  clearSuppressedSources,
} from "../src/resolve.js";

test("source candidates are deduplicated by URL and keep the existing resolver first at equal quality", () => {
  const rows = mergeCandidates(
    [
      { url: "https://media.example/a.mp4", quality: "1080p", provider: "existing" },
      { url: "https://media.example/low.mp4", quality: "720p", provider: "existing" },
    ],
    [
      {
        url: "https://media.example/a.mp4",
        name: "Source Resolver 1080p",
        requestHeaders: { Referer: "https://media.example/" },
      },
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
  assert.equal(rows[0].requestHeaders.Referer, "https://media.example/");
  assert.equal(rows[1].resolver, "secondary");
});

test("4K selection does not silently choose a 1080p source", () => {
  const picked = pickSource(
    [{ url: "https://media.example/only-1080.mp4", quality: "1080p" }],
    "4k",
  );
  assert.equal(picked.url, null);
  assert.equal(picked.matched, false);
  assert.deepEqual(picked.available, ["1080p"]);
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

test("playback byte probe rejects a host that answers HEAD but refuses the file", async () => {
  const methods = [];
  const ranges = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    ranges.push(req.headers.range || "");
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "downloadQuotaExceeded" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const candidate = {
    probeUrl: `http://127.0.0.1:${address.port}/video.mp4`,
    requestHeaders: {},
  };

  try {
    assert.equal(await validateCandidate(candidate), true);
    assert.equal(await validateCandidateForPlayback(candidate), false);
    assert.deepEqual(methods, ["HEAD", "GET"]);
    assert.equal(ranges[1], "bytes=0-0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("playback failure suppresses the cached candidate and selects the next 4K source", async () => {
  clearSuppressedSources();
  const originalFetch = globalThis.fetch;
  let deadRangeGets = 0;
  let goodRangeGets = 0;

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (value.includes("/v1/movies/991234")) {
      return new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (value.includes("/stream/movie/") && value.includes("991234")) {
      return new Response(
        JSON.stringify({
          streams: [
            { url: "https://dead.example/video.mp4", quality: "4k" },
            { url: "https://good.example/video.mp4", quality: "4k" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (value === "https://dead.example/video.mp4") {
      if (method === "HEAD") return new Response(null, { status: 200 });
      deadRangeGets += 1;
      return new Response(JSON.stringify({ error: "downloadQuotaExceeded" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    if (value === "https://good.example/video.mp4") {
      if (method === "HEAD") return new Response(null, { status: 200 });
      goodRangeGets += 1;
      return new Response("x", {
        status: 206,
        headers: { "content-range": "bytes 0-0/10", "content-type": "video/mp4" },
      });
    }

    throw new Error(`unexpected ${method} ${value}`);
  };

  try {
    const picked = await resolveMovie("991234", "4k");
    assert.equal(picked.url, "https://good.example/video.mp4");
    assert.equal(picked.quality, "4k");
    assert.equal(picked.matched, true);
    assert.equal(picked.playbackValidated, true);
    assert.equal(picked.failoverAttempts, 1);
    assert.equal(deadRangeGets, 1);
    assert.equal(goodRangeGets, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearSuppressedSources();
  }
});

test("playback suppression does not hide candidates from maintenance discovery", () => {
  clearSuppressedSources();
  try {
    suppressSource("https://media.example/a.mp4", 60000);
    const rows = mergeCandidates(
      [{ url: "https://media.example/a.mp4", quality: "4k" }],
      [],
      "4k",
    );
    assert.deepEqual(rows.map((row) => row.url), ["https://media.example/a.mp4"]);
  } finally {
    clearSuppressedSources();
  }
});

test("catalog availability is indeterminate when either source resolver itself fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/v1/movies/")) {
      return new Response(JSON.stringify({ error: "temporary" }), { status: 500 });
    }
    if (value.includes("/stream/movie/")) {
      return new Response(JSON.stringify({ streams: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ${value}`);
  };

  try {
    const result = await checkMovieAvailability("123");
    assert.equal(result.state, "indeterminate");
    assert.equal(result.reason, "provider-error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog availability records unavailable only when both resolvers answer with no direct sources", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/v1/movies/")) {
      return new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.includes("/stream/movie/")) {
      return new Response(JSON.stringify({ streams: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ${value}`);
  };

  try {
    const result = await checkMovieAvailability("456");
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "no-direct-sources");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
