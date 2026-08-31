import { isGeneratedChannelLogo } from "./channel-logos.js";
import {
  channelBroadcastCountries,
  channelCoversCountry,
  channelIdentityKeys,
  normalizeCountryCode,
} from "./channel-identity.js";
import { matchGuideChannel } from "./guide.js";

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
    byId.set(channel.id, channel);
    const countries = channelBroadcastCountries(channel);
    const indexCountries = countries.length ? countries : [normalizeCountryCode(channel.country) || ""];
    for (const value of [channel.id, channel.name, ...(channel.alt_names || [])]) {
      for (const cc of indexCountries) {
        for (const key of channelIdentityKeys(value, cc)) {
          if (cc) add(aliases, `${cc}|${key}`, channel);
          add(aliases, `*|${key}`, channel);
        }
      }
    }
  }
  return { aliases, byId };
}

function uniqueAlias(index, country, values) {
  for (const value of values.filter(Boolean)) {
    for (const key of channelIdentityKeys(value, country)) {
      if (country) {
        const local = index.aliases.get(`${country}|${key}`) || [];
        if (local.length === 1) return local[0];
      }
      if (!country) {
        const global = index.aliases.get(`*|${key}`) || [];
        if (global.length === 1) return global[0];
      }
    }
  }
  return null;
}

function matchChannelIdentity(channel, index) {
  const country = normalizeCountryCode(channel?.country);
  const direct = index.byId.get(String(channel?.iptvOrgId || ""));
  if (direct && channelCoversCountry(direct, country)) return direct;
  return uniqueAlias(index, country, [
    channel?.name,
    channel?.tvgId,
    ...(channel?.sourceTvgIds || []),
    ...(channel?.candidates || []).map((candidate) => candidate?.label),
  ]);
}

function matchGuideIdentity(hit, country, index) {
  const direct = index.byId.get(String(hit?.id || ""));
  if (direct && channelCoversCountry(direct, country)) return direct;
  return uniqueAlias(index, country, [hit?.id, ...(hit?.meta?.display || [])]);
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
    const country = normalizeCountryCode(channel.country);

    // Logo recovery should not depend on already having a good XMLTV match.
    // First use the channel's own normalized identity; only then bridge through
    // a guide identity when that adds information.
    let metadata = matchChannelIdentity(channel, index);
    if (!metadata) {
      const hit = matchGuideChannel(channel, docs);
      if (hit) metadata = matchGuideIdentity(hit, country, index);
    }
    if (!metadata) continue;
    candidates += 1;

    const logo = bestLogo(iptvOrg.logos || [], metadata.id);
    if (!logo) continue;

    channel.logo = logo;
    // Preserve the historical diagnostics contract even though identity-first
    // recovery can now succeed before an XMLTV match is available.
    channel.logoSource = "iptv-epg-identity";
    channel.logoIdentity = metadata.id;
    if (!channel.iptvOrgId) channel.iptvOrgId = metadata.id;
    applied += 1;
  }

  return { applied, candidates };
}
