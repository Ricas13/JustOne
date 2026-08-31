import crypto from "node:crypto";
import { config, withKey } from "./config.js";

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
    const matched = iptvOrg ? matchIptvChannel(row, channels) : null;
    const country = normalizeCountryCode(matched?.country || countryCode(row));
    const id = `channel.${hash(`${row.url}|${row.tvgId || ""}|${row.name || ""}`)}`;
    const matchedLogo = matched ? bestLogo(logos.get(matched.id) || []) : "";
    const name = text(row.tvgName || row.name || `Channel ${index + 1}`);
    const group = sourceGroupForPresentation(row.group, name, country);

    return {
      id,
      tvgId: matched?.id || row.tvgId || `justone.${id}`,
      sourceTvgIds: row.tvgId ? [row.tvgId] : [],
      iptvOrgId: matched?.id || "",
      name,
      group,
      country,
      number: Number(row.number || index + 1),
      logo: row.logo || matchedLogo || generatedLogo(id),
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
