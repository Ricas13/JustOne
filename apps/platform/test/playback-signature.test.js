import test from "node:test";
import assert from "node:assert/strict";

process.env.PUBLIC_URL = "https://resolver.example";
process.env.PLAYBACK_URL = "https://resolver.example";
process.env.PLAYLIST_KEY = "playlist-master-key";
process.env.STREAM_SIGNING_SECRET = "stream-signing-test-secret";
process.env.STREAM_TOKEN_TTL_SECONDS = "600";
process.env.ADMIN_PASSWORD = "admin-test-password";

const { signPlaybackUrl, hasValidPlaybackSignature } = await import("../src/playbackSignature.js");
const { hasPlaylistKey } = await import("../src/auth.js");

function reqFor(url, remoteAddress = "203.0.113.10") {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    headers: {},
    socket: { remoteAddress },
  };
}

test("signed live URL is accepted before expiry", () => {
  const now = 1_800_000_000_000;
  const signed = signPlaybackUrl("https://resolver.example/play/live/64.ts", now);
  assert.equal(hasValidPlaybackSignature(reqFor(signed), now + 30_000), true);
});

test("signature is bound to channel path", () => {
  const now = 1_800_000_000_000;
  const signed = new URL(signPlaybackUrl("https://resolver.example/play/live/64.ts", now));
  signed.pathname = "/play/live/65.ts";
  assert.equal(hasValidPlaybackSignature(reqFor(signed.href), now + 30_000), false);
});

test("expired signature is rejected", () => {
  const now = 1_800_000_000_000;
  const signed = signPlaybackUrl("https://resolver.example/play/live/64.ts", now);
  assert.equal(hasValidPlaybackSignature(reqFor(signed), now + 601_000), false);
});

test("playlist key no longer authorizes public /play/live", () => {
  const req = reqFor("https://resolver.example/play/live/64.ts?key=playlist-master-key");
  assert.equal(hasPlaylistKey(req), false);
});

test("loopback remains allowed for supervised internal HLS", () => {
  const req = reqFor("http://127.0.0.1:8080/play/live/64.m3u8", "127.0.0.1");
  assert.equal(hasPlaylistKey(req), true);
});
