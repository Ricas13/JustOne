import crypto from "node:crypto";
import { config } from "./config.js";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function playbackSignature(pathname, exp) {
  if (!config.streamSigningSecret) return "";
  return crypto
    .createHmac("sha256", config.streamSigningSecret)
    .update(`${String(pathname)}\n${String(exp)}`)
    .digest("hex");
}

export function signPlaybackUrl(value, now = Date.now()) {
  const url = new URL(String(value));
  if (!config.streamSigningSecret) throw new Error("STREAM_SIGNING_SECRET is required for public event playback");
  const exp = Math.floor(now / 1000) + config.streamTokenTtlSeconds;
  url.searchParams.delete("key");
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", playbackSignature(url.pathname, exp));
  return url.href;
}

export function hasValidPlaybackSignature(req, now = Date.now()) {
  if (!config.streamSigningSecret) return false;
  const exp = Number(req.query?.exp);
  const sig = String(req.query?.sig || "");
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(now / 1000) || !sig) return false;
  return safeEqual(sig, playbackSignature(req.path, exp));
}
