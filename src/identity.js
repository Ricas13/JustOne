import { hash, normalize, slug, text } from "./util.js";

const QUALITY_PATTERNS = [
  ["UHD", /\b(?:uhd|4k|2160p)\b/i],
  ["FHD", /\b(?:fhd|full\s*hd|1080p?)\b/i],
  ["HD", /\b(?:hd|720p?)\b/i],
  ["SD", /\b(?:sd|576p?|480p?)\b/i],
];

const BACKUP_RE = /\b(?:backup|back[- ]?up|secondary|alternate|alternative|alt|reserve|spare|mirror)\b/i;
const PREFIX_RE = /^\s*(?:uk|gb|us|usa|pt|fr|de|es|it|ca|au)\s*[:|\-]\s*/i;
const DECORATION_RE = /(?:\[[^\]]*\]|\([^)]*(?:uhd|4k|fhd|hd|sd|backup|alt|1080|720|576|480)[^)]*\))/gi;

export function qualityOf(value) {
  const s = text(value);
  return QUALITY_PATTERNS.find(([, re]) => re.test(s))?.[0] || "UNKNOWN";
}

export function isBackup(value) {
  return BACKUP_RE.test(text(value));
}

export function strippedChannelName(value) {
  let s = text(value).replace(PREFIX_RE, "").replace(DECORATION_RE, " ");
  s = s
    .replace(/\b(?:uhd|4k|2160p|fhd|full\s*hd|1080p?|hd|720p?|sd|576p?|480p?)\b/gi, " ")
    .replace(BACKUP_RE, " ")
    .replace(/\b(?:stream|feed)\s*\d*\b/gi, " ")
    .replace(/\s+[|:\-]\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || text(value);
}

export function canonicalIdentity(row, aliases = {}) {
  const candidate = text(row.tvgName || row.name);
  const stripped = strippedChannelName(candidate);
  const key = normalize(stripped);
  const aliased = text(aliases[key] || stripped);
  const canonicalKey = normalize(aliased);
  const short = slug(aliased).slice(0, 48);
  const suffix = hash(canonicalKey, 8);
  return {
    key: canonicalKey,
    id: `${short}-${suffix}`,
    tvgId: `justone.${short}.${suffix}`,
    name: aliased,
  };
}

export function countryOf(row) {
  const hay = normalize(`${row.group || ""} ${row.name || ""}`);
  const rules = [
    ["GB", /\b(?:uk|gb|united kingdom|england|scotland|wales)\b/],
    ["US", /\b(?:us|usa|united states)\b/],
    ["PT", /\b(?:pt|portugal)\b/],
    ["ES", /\b(?:es|spain)\b/],
    ["FR", /\b(?:fr|france)\b/],
    ["DE", /\b(?:de|germany)\b/],
    ["IT", /\b(?:it|italy)\b/],
    ["CA", /\b(?:ca|canada)\b/],
    ["AU", /\b(?:au|australia)\b/],
  ];
  return rules.find(([, re]) => re.test(hay))?.[0] || "";
}

export function canonicalGroup(row) {
  const cc = countryOf(row);
  if (cc) return `TV | ${cc}`;
  return text(row.group || "TV | International");
}

export function variantRank(variant, qualityOrder) {
  const q = qualityOrder.indexOf(variant.quality);
  const quality = q === -1 ? qualityOrder.length : q;
  return quality * 2 + (variant.backup ? 1 : 0);
}
