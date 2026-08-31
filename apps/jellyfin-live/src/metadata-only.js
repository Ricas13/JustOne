import crypto from "node:crypto";
import { config, withKey } from "./config.js";
import {
  channelBroadcastCountries,
  channelCoversCountry,
  channelIdentityKeys,
  normalizeCountryCode,
} from "./channel-identity.js";

const COUNTRY_CODES = new Map([
  ["uk", "GB"], ["united kingdom", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"],
  ["usa", "US"], ["us", "US"], ["united states", "US"], ["portugal", "PT"], ["spain", "ES"],
  ["france", "FR"], ["germany", "DE"], ["italy", "IT"], ["canada", "CA"], ["ireland", "IE"],
  ["netherlands", "NL"], ["australia", "AU"], ["brazil", "BR"], ["poland", "PL"], ["romania", "RO"],
  ["greece", "GR"], ["turkey", "TR"], ["türkiye", "TR"], ["sweden", "SE"], ["norway", "NO"], ["denmark", "DK"],
  ["finland", "FI"], ["austria", "AT"], ["switzerland", "CH"], ["belgium", "BE"], ["czechia", "CZ"],
  ["czech republic", "CZ"], ["slovakia", "SK"], ["serbia", "RS"], ["croatia", "HR"], ["slovenia", "SI"],
  ["ukraine", "UA"], ["russia", "RU"], ["israel", "IL"], ["india", "IN"], ["pakistan", "PK"],
  ["malaysia", "MY"], ["japan", "JP"], ["korea", "KR"], ["china", "CN"], ["mexico", "MX"],
  ["argentina", "AR"], ["uae", "AE"], ["united arab emirates", "AE"], ["qatar", "QA"], ["bulgaria", "BG"],
  ["cyprus", "CY"], ["hungary", "HU"], ["new zealand", "NZ"], ["nz", "NZ"], ["south africa", "ZA"],
  ["chile", "CL"], ["uruguay", "UY"], ["colombia", "CO"], ["ecuador", "EC"], ["bolivia", "BO"],
  ["peru", "PE"], ["paraguay", "PY"], ["venezuela", "VE"], ["costa rica", "CR"], ["puerto rico", "PR"],
  ["lithuania", "LT"], ["latvia", "LV"], ["estonia", "EE"], ["iceland", "IS"], ["bosnia", "BA"],
  ["montenegro", "ME"], ["albania", "AL"], ["georgia", "GE"], ["armenia", "AM"], ["azerbaijan", "AZ"],
  ["morocco", "MA"], ["algeria", "DZ"], ["tunisia", "TN"], ["egypt", "EG"], ["saudi arabia", "SA"],
  ["saudi", "SA"], ["jordan", "JO"], ["iraq", "IQ"], ["iran", "IR"], ["thailand", "TH"],
  ["singapore", "SG"], ["philippines", "PH"], ["indonesia", "ID"], ["vietnam", "VN"], ["bangladesh", "BD"],
]);

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hash(value, length = 14) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function countryCode(ch) {
  const title = text(ch?.tvgName || ch?.name);
  if (/^5\s*USA$/i.test(title)) return "GB";
  if (/^BBC\s+America\b/i.test(title)) return "US";

  // Strong broadcaster families that frequently arrive without a country
  // suffix in the raw provider feed.
  if (/^Astro\b/i.test(title)) return "MY";
  if (/^SuperSport\b/i.test(title)) return "ZA";
  if (/^Alkass\b/i.test(title)) return "QA";
  if (/^SSC\s+Sport\b/i.test(title)) return "SA";

  const hay = `${ch?.group || ""} ${ch?.name || ""}`.toLowerCase();
  for (const [name, code] of COUNTRY_CODES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(hay)) return code;
  }
  const suffix = /\.([a-z]{2})(?:\d)?$/i.exec(ch?.tvgId || "")?.[1];
  return normalizeCountryCode(suffix || "");
}

function isAdultChannel(ch) {
  return /(^|\b)(18\+|adult|xxx|porn|playboy|brazzers|redlight|babestation)(\b|$)/i.test(
    `${ch?.name || ""} ${ch?.group || ""}`,
  );
}

function addNameIndex(map, composite, channel) {
  const rows = map.get(composite) || [];
  if (!rows.some((row) => row.id === channel.id)) rows.push(channel);
  map.set(composite, rows);
}

function channelIndex(channels = []) {
  const byId = new Map();
  const byName = new Map();
  for (const ch of channels) {
    if (!ch?.id || ch.is_nsfw) continue;
    byId.set(String(ch.id), ch);
    const countries = channelBroadcastCountries(ch);
    const indexCountries = countries.length ? countries : [normalizeCountryCode(ch.country) || ""];
    for (const value of [ch.id, ch.name, ...(ch.alt_names || [])]) {
      for (const cc of indexCountries) {
        for (const key of channelIdentityKeys(value, cc)) {
          if (cc) addNameIndex(byName, `${cc}|${key}`, ch);
          addNameIndex(byName, `*|${key}`, ch);
        }
      }
    }
  }
  return { byId, byName };
}

function matchIptvChannel(row, index) {
  const country = countryCode(row);
  const direct = index.byId.get(String(row.tvgId || ""));
  if (direct && channelCoversCountry(direct, country)) return direct;

  for (const value of [row.tvgId, row.tvgName, row.name]) {
    for (const key of channelIdentityKeys(value, country)) {
      if (country) {
        const exact = index.byName.get(`${country}|${key}`) || [];
        if (exact.length === 1) return exact[0];
      }
      if (!country) {
        const global = index.byName.get(`*|${key}`) || [];
        if (global.length === 1) return global[0];
      }
    }
  }
  return null;
}

function logoIndex(logos = []) {
  const map = new Map();
  for (const logo of logos) {
    if (!logo?.channel || logo.in_use === false || !/^https?:\/\//i.test(String(logo.url || ""))) continue;
    const rows = map.get(logo.channel) || [];
    rows.push(logo);
    map.set(logo.channel, rows);
  }
  return map;
}

function bestLogo(rows = []) {
  const score = (row) => {
    let value = 0;
    if (/PNG|JPEG|JPG|WEBP/i.test(row.format || "")) value += 20;
    if (/horizontal/i.test((row.tags || []).join(" "))) value += 5;
    if (!/white/i.test((row.tags || []).join(" "))) value += 2;
    value += Math.min(Number(row.width || 0) / 1000, 3);
    return value;
  };
  return [...rows].sort((a, b) => score(b) - score(a))[0]?.url || "";
}

function generatedLogo(id) {
  return withKey(`${config.publicUrl}/jellyfin/artwork/channel/${encodeURIComponent(id)}.png`);
}

function sourceGroupForPresentation(groupValue, name, country) {
  const group = text(groupValue || "Live") || "Live";

  // Real output audit: Diamond League event rows can arrive inside a country
  // TV group because the upstream source name ends in its broadcaster. Mark the
  // event discipline here so the organizer places it with sports events.
  if (/\bdiamond\s+league\b/i.test(String(name || ""))) return "Athletics";

  const sourceSays247 = /^(?:24\s*\/\s*7|24x7)(?:\s+channels?)?$/i.test(group);
  const channelItselfSays247 = /(?:24\s*\/\s*7|24x7)/i.test(String(name || ""));

  // The provider's 24/7 bucket currently contains many ordinary linear
  // networks (Discovery, Fox News, TSN, Cosmote Sport, etc.). Only preserve a
  // dedicated 24/7 section when the channel itself is explicitly a 24/7 feed.
  // Ordinary linear channels go back through normal country organisation.
  if (sourceSays247 && !channelItselfSays247) return country || "Live";
  return group;
}

/**
 * Give every final Jellyfin row its own XMLTV identity while retaining the
 * original/shared guide id in sourceTvgIds for guide matching.
 *
 * Some provider playlists repeat the exact same tvg-id and playback URL many
 * times. A URL-only suffix is therefore not unique. The occurrence number is
 * included in the stable fingerprint so even byte-identical repeated rows get
 * distinct ids without touching their playback URL.
 */
export function ensureUniqueTvgIds(rows = []) {
  const used = new Set();
  const nextOccurrence = new Map();

  for (const row of rows) {
    const base = text(row?.tvgId) || `justone.${row?.id || hash(row?.url || "channel")}`;
    if (!used.has(base)) {
      row.tvgId = base;
      used.add(base);
      nextOccurrence.set(base, 2);
      continue;
    }

    const sourceIds = new Set(Array.isArray(row.sourceTvgIds) ? row.sourceTvgIds : []);
    sourceIds.add(base);
    row.sourceTvgIds = [...sourceIds];

    let occurrence = nextOccurrence.get(base) || 2;
    let candidate = "";
    do {
      const fingerprint = [
        row?.id || "",
        row?.url || "",
        row?.name || "",
        row?.group || "",
        occurrence,
      ].join("|");
      candidate = `${base}.justone.${hash(fingerprint, 8)}`;
      occurrence += 1;
    } while (used.has(candidate));

    nextOccurrence.set(base, occurrence);
    row.tvgId = candidate;
    used.add(candidate);
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
    const inferredCountry = normalizeCountryCode(countryCode(row));
    const matched = iptvOrg ? matchIptvChannel(row, channels) : null;
    // Multinational networks such as Eurosport have a canonical IPTV-org home
    // country but country-specific feeds. Preserve the provider's actual country
    // bucket when it is known instead of moving the row to the metadata home.
    const country = inferredCountry || normalizeCountryCode(matched?.country || "");
    const id = `channel.${hash(`${row.url}|${row.tvgId || ""}|${row.name || ""}`)}`;
    const matchedLogo = matched ? bestLogo(logos.get(matched.id) || []) : "";
    const name = text(row.tvgName || row.name || `Channel ${index + 1}`);
    const group = sourceGroupForPresentation(row.group, name, country);
    const logo = matchedLogo || row.logo || generatedLogo(id);

    return {
      id,
      tvgId: matched?.id || row.tvgId || `justone.${id}`,
      sourceTvgIds: row.tvgId ? [row.tvgId] : [],
      iptvOrgId: matched?.id || "",
      name,
      group,
      country,
      number: Number(row.number || index + 1),
      logo,
      logoSource: matchedLogo ? "iptv-org" : row.logo ? "source" : "generated",
      kind: "static",
      programmes: [],
      candidates: [{ url: row.url, label: text(row.name || row.tvgName || name) }],
      url: row.url,
    };
  });

  return ensureUniqueTvgIds(out);
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
