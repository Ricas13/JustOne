import { normalizeRemoteImageUrl } from "./cache.js";

const PLACEHOLDER_TOKEN = "0".repeat(64);

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLocalJellyfinImage(value) {
  try {
    const url = new URL(String(value || ""));
    return /^\/jellyfin\/(?:image|artwork)\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export function cachedImagePublicUrl(value, cache, { publicUrl, playlistKey = "" } = {}) {
  const raw = String(value || "").trim();
  if (isLocalJellyfinImage(raw)) return raw;

  const source = normalizeRemoteImageUrl(raw);
  const registered = source ? cache.register(source) : null;
  const token = registered?.token || PLACEHOLDER_TOKEN;
  const url = new URL(`${String(publicUrl || "").replace(/\/$/, "")}/jellyfin/image/${token}`);
  if (playlistKey) url.searchParams.set("key", playlistKey);
  return url.href;
}

export function rewriteM3uImages(body, cache, options) {
  return String(body || "").replace(/(\btvg-logo=")([^"]*)(")/gi, (_match, before, value, after) => {
    return `${before}${cachedImagePublicUrl(value, cache, options)}${after}`;
  });
}

export function rewriteXmlTvImages(body, cache, options) {
  let out = String(body || "");

  out = out.replace(/(<icon\b[^>]*\bsrc=")([^"]*)(")/gi, (_match, before, value, after) => {
    const local = cachedImagePublicUrl(value, cache, options);
    return `${before}${xmlEscape(local)}${after}`;
  });

  out = out.replace(/(<image\b[^>]*>)([^<]*)(<\/image>)/gi, (_match, before, value, after) => {
    const local = cachedImagePublicUrl(value, cache, options);
    return `${before}${xmlEscape(local)}${after}`;
  });

  return out;
}
