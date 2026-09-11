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

function stripProgrammeArtwork(block) {
  return String(block || "")
    .replace(/<icon\b[^>]*\/?\s*>/gi, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "");
}

function stripKnownBadRatings(block) {
  // Jellyfin 12 logs one warning per programme for this value because FR-NR is
  // not part of its FR rating table. Dropping only this invalid rating keeps
  // valid parental ratings intact while avoiding thousands of warnings.
  return String(block || "").replace(
    /<rating\b[^>]*\bsystem=["']FR["'][^>]*>[\s\S]*?<value\b[^>]*>\s*FR-NR\s*<\/value>[\s\S]*?<\/rating>/gi,
    "",
  );
}

export function rewriteXmlTvImages(body, cache, options = {}) {
  let out = String(body || "");

  // Jellyfin 12 currently re-applies and re-downloads programme artwork on
  // every guide refresh (jellyfin/jellyfin#17259, fix PR #17265). On a large
  // XMLTV feed that causes tens of thousands of image writes/re-encodes and can
  // make Refresh Guide run for minutes or hours. Keep the bounded channel logos
  // but strip programme artwork until Jellyfin ships the upstream fix.
  const stripProgramArtwork = options.stripProgramArtwork !== false;
  const stripInvalidRatings = options.stripInvalidRatings !== false;
  out = out.replace(/<programme\b[^>]*>[\s\S]*?<\/programme>/gi, (programme) => {
    let next = programme;
    if (stripProgramArtwork) next = stripProgrammeArtwork(next);
    if (stripInvalidRatings) next = stripKnownBadRatings(next);
    return next;
  });

  // Remaining icon/image elements are channel-level metadata. Route those
  // through the persistent local cache so Jellyfin never reaches third-party
  // image hosts directly.
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
