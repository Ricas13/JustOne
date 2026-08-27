import crypto from "node:crypto";
import { config } from "./config.js";

const COOKIE = "justone_admin";

function token() {
  return crypto.createHmac("sha256", config.adminPassword).update("session").digest("hex");
}

export function parseCookie(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!config.adminPassword) return true;
  const got = parseCookie(req.headers.cookie)[COOKIE];
  if (!got) return false;
  const expect = token();
  const a = Buffer.from(got);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function setAuthCookie(res) {
  const secure = config.publicUrl.startsWith("https") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`,
  );
}

export function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

export function isPublicPath(pathname) {
  return (
    pathname.startsWith("/play/") ||
    pathname.startsWith("/resolve/") ||
    pathname.startsWith("/cinepro") ||
    pathname.startsWith("/stremio") ||
    pathname.startsWith("/api/proxy") ||
    pathname.startsWith("/api/stream") ||
    (pathname.startsWith("/live/") && pathname.endsWith(".m3u8")) ||
    pathname === "/login" ||
    pathname === "/login.html"
  );
}

export function isStreamPath(pathname) {
  return (
    pathname.startsWith("/play/") ||
    pathname.startsWith("/resolve/") ||
    pathname.startsWith("/cinepro") ||
    pathname.startsWith("/stremio") ||
    pathname.startsWith("/api/proxy") ||
    pathname.startsWith("/api/stream") ||
    (pathname.startsWith("/live/") && pathname.endsWith(".m3u8"))
  );
}

function loopback(req) {
  const ip = String(req.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function hasPlaylistKey(req) {
  if (!config.playlistKey) return true;
  if (loopback(req)) return true;
  if (isAuthed(req)) return true;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const got = String(req.query?.key || req.query?.token || req.headers["x-playlist-key"] || bearer || "");
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(config.playlistKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
