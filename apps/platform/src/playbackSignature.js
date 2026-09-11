import crypto from "node:crypto";
import { config } from "./config.js";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function secret() {
  return config.streamSigningSecret || "";
}

export function playbackSignature(pathname, exp) {
  if (!secret()) return "";
  return crypto
    .createHmac("sha256", secret())
    .update(`${String(pathname)}\n${String(exp)}`)
    .digest("hex");
}

export function stablePlaybackSignature(pathname) {
  if (!secret()) return "";
  return crypto
    .createHmac("sha256", secret())
    .update(`stable\n${String(pathname)}`)
    .digest("hex");
}

// Jellyfin hashes the exact M3U stream URL to build its internal channel id.
// A time-varying exp/sig therefore changes every channel id whenever the
// playlist refreshes and leaves existing Jellyfin items pointing at a channel
// the tuner no longer has. Use a stable path-bound HMAC for playlist URLs.
// Rotating STREAM_SIGNING_SECRET revokes all issued stable playback URLs.
export function signPlaybackUrl(value) {
  const url = new URL(String(value));
  if (!secret()) throw new Error("STREAM_SIGNING_SECRET is required for public live playback");
  url.searchParams.delete("key");
  url.searchParams.delete("exp");
  url.searchParams.delete("sig");
  url.searchParams.set("token", stablePlaybackSignature(url.pathname));
  return url.href;
}

// Keep the previous expiring format available for callers that need a
// short-lived URL and to preserve compatibility with already-issued playlists.
export function signExpiringPlaybackUrl(value, now = Date.now()) {
  const url = new URL(String(value));
  if (!secret()) throw new Error("STREAM_SIGNING_SECRET is required for public live playback");
  const exp = Math.floor(now / 1000) + config.streamTokenTtlSeconds;
  url.searchParams.delete("key");
  url.searchParams.delete("token");
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", playbackSignature(url.pathname, exp));
  return url.href;
}

export function hasValidPlaybackSignature(req, now = Date.now()) {
  if (!secret()) return false;

  const stableToken = String(req.query?.token || "");
  if (stableToken && safeEqual(stableToken, stablePlaybackSignature(req.path))) return true;

  const exp = Number(req.query?.exp);
  const sig = String(req.query?.sig || "");
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(now / 1000) || !sig) return false;
  const expected = playbackSignature(req.path, exp);
  return safeEqual(sig, expected);
}
