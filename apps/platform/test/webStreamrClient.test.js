import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { fetchMovieStreams, fetchEpisodeStreams } from "../src/services/webStreamrClient.js";

test("stream provider client uses TMDB movie and episode IDs and preserves request headers", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({
      streams: [
        {
          name: "Source Resolver\n1080p",
          title: "Example",
          url: "https://media.example/video.mp4",
          behaviorHints: {
            proxyHeaders: { request: { Referer: "https://media.example/" } },
          },
        },
        { name: "External only", externalUrl: "https://example.invalid/page" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const movie = await fetchMovieStreams("123");
    const episode = await fetchEpisodeStreams("456", 2, 7);

    assert.equal(movie.length, 1);
    assert.equal(movie[0].url, "https://media.example/video.mp4");
    assert.equal(movie[0].requestHeaders.Referer, "https://media.example/");
    assert.match(seen[0], /\/stream\/movie\/tmdb%3A123\.json$/);
    assert.match(seen[1], /\/stream\/series\/tmdb%3A456%3A2%3A7\.json$/);
    assert.equal(episode.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive lazy extraction rejects quota JSON even when an intermediary returns HTTP 200", async () => {
  const originalFetch = globalThis.fetch;
  const dead = `${config.streamProviderUrl}/config/extract/?index=0&url=https%3A%2F%2Fdead.example`;
  const good = `${config.streamProviderUrl}/config/extract/?index=1&url=https%3A%2F%2Fgood.example`;
  const finalGood = "https://cdn.example/video.mp4?token=ok";

  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);

    if (value.includes("/stream/movie/") && value.includes("tmdb%3A999")) {
      return new Response(
        JSON.stringify({
          streams: [
            { url: dead, quality: "4k", name: "WebStreamr 4K" },
            { url: good, quality: "4k", name: "WebStreamr 4K" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (value === dead) {
      assert.equal(String(options.method || "GET").toUpperCase(), "GET");
      assert.match(String(options.headers?.Range || options.headers?.range || ""), /^bytes=0-/);
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: "The download quota for this file has been exceeded.",
            errors: [
              {
                message: "The download quota for this file has been exceeded.",
                domain: "usageLimits",
                reason: "downloadQuotaExceeded",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (value === good) {
      const response = new Response("x", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 0-0/10",
        },
      });
      Object.defineProperty(response, "url", { value: finalGood });
      return response;
    }

    throw new Error(`unexpected ${value}`);
  };

  try {
    const rows = await fetchMovieStreams("999");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, finalGood);
    assert.equal(rows[0].materializedFrom, good);
    assert.equal(rows[0].quality, "4k");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
