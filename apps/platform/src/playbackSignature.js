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

export function signPlaybackUrl(value, now = Date.now()) {
  const url = new URL(String(value));
  if (!secret()) throw new Error("STREAM_SIGNING_SECRET is required for public live playback");
  const exp = Math.floor(now / 1000) + config.streamTokenTtlSeconds;
  url.searchParams.delete("key");
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", playbackSignature(url.pathname, exp));
  return url.href;
}

export function hasValidPlaybackSignature(req, now = Date.now()) {
  if (!secret()) return false;
  const exp = Number(req.query?.exp);
  const sig = String(req.query?.sig || "");
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(now / 1000) || !sig) return false;
  const expected = playbackSignature(req.path, exp);
  return safeEqual(sig, expected);
}
