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

const COUNTRY_RULES = [
  ["GB", /\b(?:uk|gb|united kingdom|england|scotland|wales)\b/],
  ["US", /\b(?:us|usa|united states)\b/],
  ["PT", /\b(?:pt|portugal)\b/],
  ["ES", /\b(?:es|spain)\b/],
  ["FR", /\b(?:fr|france)\b/],
  ["DE", /\b(?:de|germany)\b/],
  ["IT", /\b(?:it|italy)\b/],
  ["CA", /\b(?:ca|canada)\b/],
  ["AU", /\b(?:au|australia)\b/],
  ["GR", /\b(?:gr|greece)\b/],
  ["NL", /\b(?:nl|netherlands|holland)\b/],
  ["PL", /\b(?:pl|poland)\b/],
  ["DK", /\b(?:dk|denmark)\b/],
  ["BG", /\b(?:bg|bulgaria)\b/],
  ["TR", /\b(?:tr|turkey|turkiye)\b/],
  ["AR", /\b(?:ar|argentina)\b/],
  ["IE", /\b(?:ie|ireland)\b/],
  ["RO", /\b(?:ro|romania)\b/],
  ["SE", /\b(?:se|sweden)\b/],
  ["NO", /\b(?:no|norway)\b/],
  ["FI", /\b(?:fi|finland)\b/],
  ["IL", /\b(?:il|israel)\b/],
  ["MX", /\b(?:mx|mexico)\b/],
  ["BR", /\b(?:br|brazil)\b/],
  ["NZ", /\b(?:nz|new zealand)\b/],
  ["JP", /\b(?:jp|japan)\b/],
  ["KR", /\b(?:kr|south korea|korea)\b/],
  ["CN", /\b(?:cn|china)\b/],
  ["RU", /\b(?:ru|russia)\b/],
  ["SK", /\b(?:sk|slovakia)\b/],
  ["CZ", /\b(?:cz|czech republic|czechia)\b/],
  ["RS", /\b(?:rs|serbia)\b/],
  ["HR", /\b(?:hr|croatia)\b/],
  ["BE", /\b(?:be|belgium)\b/],
  ["CH", /\b(?:switzerland)\b/],
  ["AT", /\b(?:austria)\b/],
  ["AE", /\b(?:ae|united arab emirates|uae)\b/],
  ["SA", /\b(?:sa|saudi arabia)\b/],
  ["QA", /\b(?:qa|qatar)\b/],
];

const COUNTRY_SUFFIX_MAP = {
  uk:"GB", gb:"GB", us:"US", usa:"US", pt:"PT", es:"ES", fr:"FR", de:"DE", it:"IT", ca:"CA", au:"AU",
  gr:"GR", nl:"NL", pl:"PL", dk:"DK", bg:"BG", tr:"TR", ar:"AR", ie:"IE", ro:"RO", se:"SE", no:"NO",
  fi:"FI", il:"IL", mx:"MX", br:"BR", nz:"NZ", jp:"JP", kr:"KR", cn:"CN", ru:"RU", sk:"SK", cz:"CZ",
  rs:"RS", hr:"HR", be:"BE", ch:"CH", at:"AT", ae:"AE", sa:"SA", qa:"QA",
};

function countryFromText(value) {
  const hay = normalize(value);
  return COUNTRY_RULES.find(([, re]) => re.test(hay))?.[0] || "";
}

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

export function countryOf(row = {}) {
  // An explicit country in the channel name/tvg-name outranks a broad provider
  // group. This prevents a row grouped as "PT" from making a reference named
  // "Eurosport 1 Greece" look Portuguese.
  const byName = countryFromText(`${row.name || ""} ${row.tvgName || ""}`);
  if (byName) return byName;

  const id = String(row.tvgId || "").toLowerCase();
  const suffix = /(?:^|[._-])(uk|gb|us|usa|pt|es|fr|de|it|ca|au|gr|nl|pl|dk|bg|tr|ar|ie|ro|se|no|fi|il|mx|br|nz|jp|kr|cn|ru|sk|cz|rs|hr|be|ch|at|ae|sa|qa)(?:$|[._-])/i.exec(id)?.[1]?.toLowerCase();
  if (suffix && COUNTRY_SUFFIX_MAP[suffix]) return COUNTRY_SUFFIX_MAP[suffix];

  return countryFromText(row.group || "");
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
