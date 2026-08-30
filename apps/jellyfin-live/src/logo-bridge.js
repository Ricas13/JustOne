import { isGeneratedChannelLogo } from "./channel-logos.js";
import { matchGuideChannel } from "./guide.js";

function normalizeCountry(value) {
  const cc = String(value || "").trim().toUpperCase();
  if (cc === "UK") return "GB";
  if (cc === "USA") return "US";
  return cc;
}

function suffixes(country) {
  switch (normalizeCountry(country)) {
    case "US": return ["usa", "us", "us2", "united states"];
    case "GB": return ["uk", "gb", "united kingdom"];
    case "PT": return ["pt", "portugal"];
    case "CA": return ["ca", "canada"];
    case "ES": return ["es", "spain"];
    case "FR": return ["fr", "france"];
    case "DE": return ["de", "germany"];
    case "IT": return ["it", "italy"];
    default: return [];
  }
}

function keys(value, country) {
  let s = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[._/+\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const suffix of suffixes(country)) {
    const re = new RegExp(`\\s+${suffix.replace(/\s+/g, "\\s+")}$`, "i");
    if (re.test(s)) s = s.replace(re, "").trim();
  }

  s = s
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return [];
  return [...new Set([s, s.replace(/\s+/g, "")])];
}

function add(map, key, channel) {
  if (!key) return;
  const rows = map.get(key) || [];
  if (!rows.some((row) => row.id === channel.id)) rows.push(channel);
  map.set(key, rows);
}

function buildIndex(channels = []) {
  const aliases = new Map();
  const byId = new Map();
  for (const channel of channels) {
    if (!channel?.id || channel.is_nsfw) continue;
    const country = normalizeCountry(channel.country);
    byId.set(channel.id, channel);
    for (const value of [channel.id, channel.name, ...(channel.alt_names || [])]) {
      for (const key of keys(value, country)) {
        add(aliases, `${country}|${key}`, channel);
        add(aliases, `*|${key}`, channel);
      }
    }
  }
  return { aliases, byId };
}

function matchIdentity(hit, country, index) {
  const direct = index.byId.get(String(hit?.id || ""));
  if (direct && (!country || normalizeCountry(direct.country) === country)) return direct;

  for (const value of [hit?.id, ...(hit?.meta?.display || [])]) {
    for (const key of keys(value, country)) {
      if (country) {
        const local = index.aliases.get(`${country}|${key}`) || [];
        if (local.length === 1) return local[0];
      }
      const global = index.aliases.get(`*|${key}`) || [];
      if (global.length === 1) return global[0];
    }
  }
  return null;
}

function bestLogo(logos = [], channelId) {
  const rows = logos.filter((row) => row.channel === channelId && row.in_use !== false && /^https?:\/\//i.test(row.url || ""));
  const score = (row) => {
    let value = 0;
    if (/PNG|JPEG|JPG|WEBP/i.test(row.format || "")) value += 20;
    if (/horizontal/i.test((row.tags || []).join(" "))) value += 5;
    if (!/white/i.test((row.tags || []).join(" "))) value += 2;
    value += Math.min(Number(row.width || 0) / 1000, 3);
    return value;
  };
  return rows.sort((a, b) => score(b) - score(a))[0]?.url || "";
}

export function applyEpgIdentityLogos(lineup, docs = [], iptvOrg = {}) {
  const index = buildIndex(iptvOrg.channels || []);
  let applied = 0;
  let candidates = 0;

  for (const channel of lineup || []) {
    if (channel?.kind !== "static" || !isGeneratedChannelLogo(channel.logo)) continue;
    const hit = matchGuideChannel(channel, docs);
    if (!hit) continue;
    candidates += 1;

    const country = normalizeCountry(channel.country);
    const metadata = matchIdentity(hit, country, index);
    if (!metadata) continue;
    const logo = bestLogo(iptvOrg.logos || [], metadata.id);
    if (!logo) continue;

    channel.logo = logo;
    channel.logoSource = "iptv-epg-identity";
    channel.logoIdentity = metadata.id;
    applied += 1;
  }

  return { applied, candidates };
}
