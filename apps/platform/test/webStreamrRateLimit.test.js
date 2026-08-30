import test from "node:test";
import assert from "node:assert/strict";

process.env.WEBSTREAMR_BACKGROUND_MIN_INTERVAL_MS = "250";
process.env.WEBSTREAMR_RATE_LIMIT_FALLBACK_MS = "60000";

const { fetchMovieStreams, webStreamrStatus } = await import(
  "../src/services/webStreamrClient.js"
);

test("WebStreamr 429 Retry-After creates a shared fail-fast cooldown", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("Too many requests, please try again later.", {
      status: 429,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": "39",
      },
    });
  };

  try {
    await assert.rejects(
      fetchMovieStreams("693134"),
      (error) =>
        error?.code === "WEBSTREAMR_RATE_LIMITED" &&
        error.retryAfterMs >= 39000 &&
        error.retryAfterMs < 41000,
    );

    const status = webStreamrStatus();
    assert.equal(status.coolingDown, true);
    assert.ok(status.remainingMs > 0);
    assert.equal(status.lastRetryAfterMs, 39000);

    await assert.rejects(
      fetchMovieStreams("693134"),
      (error) => error?.code === "WEBSTREAMR_COOLDOWN" && error.retryAfterMs > 0,
    );
    assert.equal(calls, 1, "cooldown should avoid another provider request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
