import test from "node:test";
import assert from "node:assert/strict";
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
