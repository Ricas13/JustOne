import crypto from "node:crypto";
import { config, withKey } from "./config.js";

const COUNTRY_CODES = new Map([
  ["uk", "GB"], ["united kingdom", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"],
  ["usa", "US"], ["us", "US"], ["united states", "US"], ["portugal", "PT"], ["spain", "ES"],
  ["france", "FR"], ["germany", "DE"], ["italy", "IT"], ["canada", "CA"], ["ireland", "IE"],
  ["netherlands", "NL"], ["australia", "AU"], ["brazil", "BR"], ["poland", "PL"], ["romania", "RO"],
  ["greece", "GR"], ["turkey", "TR"], ["sweden", "SE"], ["norway", "NO"], ["denmark", "DK"],
  ["finland", "FI"], ["austria", "AT"], ["switzerland", "CH"], ["belgium", "BE"], ["czechia", "CZ"],
  ["slovakia", "SK"], ["serbia", "RS"], ["croatia", "HR"], ["slovenia", "SI"], ["ukraine", "UA"],
  ["russia", "RU"], ["israel", "IL"], ["india", "IN"], ["pakistan", "PK"], ["malaysia", "MY"],
  ["japan", "JP"], ["korea", "KR"], ["china", "CN"], ["mexico", "MX"], ["argentina", "AR"],
]);

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hash(value, length = 14) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function normalizeCountryCode(value) {
  const cc = String(value || "").trim().toUpperCase();
  if (cc === "UK") return "GB";
  if (cc === "USA") return "US";
  return cc;
}

function countryCode(ch) {
  const title = text(ch?.tvgName || ch?.name);
  if (/^5\s*USA$/i.test(title)) return "GB";
  if (/^BBC\s+America\b/i.test(title)) return "US";

  const hay = `${ch?.group || ""} ${ch?.name || ""}`.toLowerCase();
  for (const [name, code] of COUNTRY_CODES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(hay)) return code;
  }
  const suffix = /\.([a-z]{2})(?:\d)?$/i.exec(ch?.tvgId || "")?.[1];
  return normalizeCountryCode(suffix || "");
}

function normalizedName(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/g, " ")
    .replace(/[._/+\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAdultChannel(ch) {
  return /(^|\b)(18\+|adult|xxx|porn|playboy|brazzers|redlight|babestation)(\b|$)/i.test(
    `${ch?.name || ""} ${ch?.group || ""}`,
  );
}

function channelIndex(channels = []) {
  const byId = new Map();
  const byName = new Map();
  for (const ch of channels) {
    if (!ch?.id || ch.is_nsfw) continue;
    byId.set(String(ch.id), ch);
    const country = normalizeCountryCode(ch.country);
    for (const value of [ch.name, ...(ch.alt_names || [])]) {
      const key = normalizedName(value);
      if (!key) continue;
      const composite = `${country}|${key}`;
      const rows = byName.get(composite) || [];
      rows.push(ch);
      byName.set(composite, rows);
    }
  }
  return { byId, byName };
}

function matchIptvChannel(row, index) {
  const direct = index.byId.get(String(row.tvgId || ""));
  const country = countryCode(row);
  if (direct && (!country || normalizeCountryCode(direct.country) === country)) return direct;

  for (const value of [row.tvgName, row.name]) {
    const key = normalizedName(value);
    if (!key) continue;
    if (country) {
      const exact = index.byName.get(`${country}|${key}`) || [];
      if (exact.length === 1) return exact[0];
    }
  }
  return null;
}

function logoIndex(logos = []) {
  const map = new Map();
  for (const logo of logos) {
    if (!logo?.channel || !/^https?:\/\//i.test(String(logo.url || ""))) continue;
    const rows = map.get(logo.channel) || [];
    rows.push(logo);
    map.set(logo.channel, rows);
  }
  return map;
}

function bestLogo(rows = []) {
  return [...rows]
    .sort((a, b) => {
      const horizontalA = Array.isArray(a.tags) && a.tags.includes("horizontal") ? 1 : 0;
      const horizontalB = Array.isArray(b.tags) && b.tags.includes("horizontal") ? 1 : 0;
      if (horizontalA !== horizontalB) return horizontalB - horizontalA;
      return Number(b.width || 0) - Number(a.width || 0);
    })[0]?.url || "";
}

function generatedLogo(id) {
  return withKey(`${config.publicUrl}/jellyfin/artwork/channel/${encodeURIComponent(id)}.png`);
}

function uniqueTvgIds(rows) {
  const used = new Set();
  for (const row of rows) {
    let id = row.tvgId || `justone.${row.id}`;
    if (used.has(id)) id = `${id}.justone.${hash(row.url, 6)}`;
    row.tvgId = id;
    used.add(id);
  }
  return rows;
}

/**
 * Metadata-only view of the raw Grok playlist.
 *
 * Playback is deliberately not resolved, probed, deduplicated, collapsed or
 * redirected here. Each accepted raw row produces exactly one Jellyfin row and
 * its `url` is copied byte-for-byte from the raw M3U.
 */
export function buildMetadataLineup(rawRows, { iptvOrg = null, excludeAdult = true } = {}) {
  const source = (rawRows || []).filter((row) => row?.url && (!excludeAdult || !isAdultChannel(row)));
  const channels = channelIndex(iptvOrg?.channels || []);
  const logos = logoIndex(iptvOrg?.logos || []);

  const out = source.map((row, index) => {
    const matched = iptvOrg ? matchIptvChannel(row, channels) : null;
    const country = normalizeCountryCode(matched?.country || countryCode(row));
    const id = `channel.${hash(`${row.url}|${row.tvgId || ""}|${row.name || ""}`)}`;
    const matchedLogo = matched ? bestLogo(logos.get(matched.id) || []) : "";
    const name = text(row.tvgName || row.name || `Channel ${index + 1}`);

    return {
      id,
      tvgId: matched?.id || row.tvgId || `justone.${id}`,
      sourceTvgIds: row.tvgId ? [row.tvgId] : [],
      iptvOrgId: matched?.id || "",
      name,
      group: text(row.group || "Live") || "Live",
      country,
      number: Number(row.number || index + 1),
      logo: row.logo || matchedLogo || generatedLogo(id),
      kind: "static",
      programmes: [],
      candidates: [{ url: row.url, label: text(row.name || row.tvgName || name) }],
      url: row.url,
    };
  });

  return uniqueTvgIds(out);
}

export function buildMetadataM3u(lineup) {
  const guide = withKey(`${config.publicUrl}/jellyfin/guide.xml`);
  const lines = [`#EXTM3U url-tvg="${guide}" x-tvg-url="${guide}" tvg-shift=0`];

  for (const ch of lineup || []) {
    if (!/^https?:\/\//i.test(String(ch?.url || ""))) continue;
    const name = text(ch.name).replace(/["\r\n]/g, " ");
    const group = text(ch.group).replace(/["\r\n]/g, " ");
    const logo = String(ch.logo || "").replace(/["\r\n]/g, " ");
    const tvgId = String(ch.tvgId || "").replace(/["\r\n]/g, " ");
    lines.push(
      `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${Number(ch.number || 0)}" group-title="${group}",${name}`,
    );
    // Critical invariant: the playback URL is the exact raw Grok M3U URL.
    lines.push(ch.url);
  }

  return lines.join("\n") + "\n";
}
