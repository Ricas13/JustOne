import { hash, normalize, slug, text } from "./util.js";

const QUALITY_PATTERNS = [
  ["UHD", /\b(?:uhd|4k|2160p)\b/i],
  ["FHD", /\b(?:fhd|full\s*hd|1080p?)\b/i],
  ["HD", /\b(?:hd|720p?)\b/i],
  ["SD", /\b(?:sd|576p?|480p?)\b/i],
];

const BACKUP_RE = /\b(?:backup|back[- ]?up|secondary|alternate|alternative|alt|reserve|spare|mirror)\b/i;
const DECORATION_RE = /(?:\[[^\]]*\]|\([^)]*(?:uhd|4k|fhd|hd|sd|backup|alt|1080|720|576|480)[^)]*\))/gi;

const COUNTRY_DEFINITIONS = [
  ["GB","United Kingdom",["united kingdom","england","scotland","wales"],["uk","gb"]],
  ["PT","Portugal",["portugal"],["pt"]],
  ["US","United States",["united states"],["usa","us"]],
  ["ES","Spain",["spain"],["es"]], ["FR","France",["france"],["fr"]], ["DE","Germany",["germany"],["de"]],
  ["IT","Italy",["italy"],["it"]], ["CA","Canada",["canada"],["ca"]], ["AU","Australia",["australia"],["au"]],
  ["GR","Greece",["greece"],["gr"]], ["NL","Netherlands",["netherlands","holland"],["nl"]], ["PL","Poland",["poland"],["pl"]],
  ["DK","Denmark",["denmark"],["dk"]], ["BG","Bulgaria",["bulgaria"],["bg"]], ["TR","Turkey",["turkey","turkiye"],["tr"]],
  ["AR","Argentina",["argentina"],["ar"]], ["IE","Ireland",["ireland"],["ie"]], ["RO","Romania",["romania"],["ro"]],
  ["SE","Sweden",["sweden"],["se"]], ["NO","Norway",["norway"],["no"]], ["FI","Finland",["finland"],["fi"]],
  ["IL","Israel",["israel"],["il"]], ["MX","Mexico",["mexico"],["mx"]], ["BR","Brazil",["brazil","brasil"],["br"]],
  ["NZ","New Zealand",["new zealand"],["nz"]], ["JP","Japan",["japan"],["jp"]], ["KR","South Korea",["south korea","korea"],["kr"]],
  ["CN","China",["china"],["cn"]], ["RU","Russia",["russia"],["ru"]], ["SK","Slovakia",["slovakia"],["sk"]],
  ["CZ","Czechia",["czech republic","czechia","czech"],["cz"]], ["RS","Serbia",["serbia"],["rs"]], ["HR","Croatia",["croatia"],["hr"]],
  ["BE","Belgium",["belgium"],["be"]], ["CH","Switzerland",["switzerland"],["ch"]], ["AT","Austria",["austria"],["at"]],
  ["AE","United Arab Emirates",["united arab emirates","uae"],["ae"]], ["SA","Saudi Arabia",["saudi arabia"],["sa"]],
  ["QA","Qatar",["qatar"],["qa"]], ["MY","Malaysia",["malaysia"],["my"]], ["IN","India",["india"],["in"]],
  ["ZA","South Africa",["south africa"],["za"]], ["EG","Egypt",["egypt"],["eg"]], ["CO","Colombia",["colombia"],["co"]],
  ["UY","Uruguay",["uruguay"],["uy"]], ["PE","Peru",["peru"],["pe"]], ["HU","Hungary",["hungary"],["hu"]],
  ["CY","Cyprus",["cyprus"],["cy"]], ["SI","Slovenia",["slovenia"],["si"]], ["BA","Bosnia and Herzegovina",["bosnia and herzegovina","bosnia"],["ba"]],
  ["ME","Montenegro",["montenegro"],["me"]], ["MK","North Macedonia",["north macedonia","macedonia"],["mk"]], ["AL","Albania",["albania"],["al"]],
  ["UA","Ukraine",["ukraine"],["ua"]], ["BY","Belarus",["belarus"],["by"]], ["LT","Lithuania",["lithuania"],["lt"]],
  ["LV","Latvia",["latvia"],["lv"]], ["EE","Estonia",["estonia"],["ee"]], ["IS","Iceland",["iceland"],["is"]],
  ["LU","Luxembourg",["luxembourg"],["lu"]], ["MT","Malta",["malta"],["mt"]], ["CL","Chile",["chile"],["cl"]],
  ["EC","Ecuador",["ecuador"],["ec"]], ["VE","Venezuela",["venezuela"],["ve"]], ["BO","Bolivia",["bolivia"],["bo"]],
  ["PY","Paraguay",["paraguay"],["py"]], ["CR","Costa Rica",["costa rica"],["cr"]], ["PA","Panama",["panama"],["pa"]],
  ["DO","Dominican Republic",["dominican republic"],["do"]], ["PR","Puerto Rico",["puerto rico"],["pr"]], ["JM","Jamaica",["jamaica"],["jm"]],
  ["TT","Trinidad and Tobago",["trinidad and tobago","trinidad"],["tt"]], ["GH","Ghana",["ghana"],["gh"]], ["NG","Nigeria",["nigeria"],["ng"]],
  ["KE","Kenya",["kenya"],["ke"]], ["MA","Morocco",["morocco"],["ma"]], ["DZ","Algeria",["algeria"],["dz"]],
  ["TN","Tunisia",["tunisia"],["tn"]], ["SN","Senegal",["senegal"],["sn"]], ["CI","Ivory Coast",["ivory coast","cote d ivoire"],["ci"]],
  ["CM","Cameroon",["cameroon"],["cm"]], ["ET","Ethiopia",["ethiopia"],["et"]], ["TZ","Tanzania",["tanzania"],["tz"]],
  ["UG","Uganda",["uganda"],["ug"]], ["ZW","Zimbabwe",["zimbabwe"],["zw"]], ["PK","Pakistan",["pakistan"],["pk"]],
  ["BD","Bangladesh",["bangladesh"],["bd"]], ["LK","Sri Lanka",["sri lanka"],["lk"]], ["NP","Nepal",["nepal"],["np"]],
  ["ID","Indonesia",["indonesia"],["id"]], ["PH","Philippines",["philippines"],["ph"]], ["TH","Thailand",["thailand"],["th"]],
  ["VN","Vietnam",["vietnam","viet nam"],["vn"]], ["SG","Singapore",["singapore"],["sg"]], ["HK","Hong Kong",["hong kong"],["hk"]],
  ["TW","Taiwan",["taiwan"],["tw"]], ["IR","Iran",["iran"],["ir"]], ["IQ","Iraq",["iraq"],["iq"]],
  ["JO","Jordan",["jordan"],["jo"]], ["LB","Lebanon",["lebanon"],["lb"]], ["KW","Kuwait",["kuwait"],["kw"]],
  ["OM","Oman",["oman"],["om"]], ["BH","Bahrain",["bahrain"],["bh"]], ["GE","Georgia",["georgia"],["ge"]],
  ["AM","Armenia",["armenia"],["am"]], ["AZ","Azerbaijan",["azerbaijan"],["az"]], ["KZ","Kazakhstan",["kazakhstan"],["kz"]],
  ["UZ","Uzbekistan",["uzbekistan"],["uz"]],
];

const COUNTRY_BY_CODE = new Map(COUNTRY_DEFINITIONS.map(([code, name, aliases, codes]) => [code, { code, name, aliases, codes }]));
const COUNTRY_CODE_TOKEN = new Map();
const COUNTRY_NAME_ALIASES = [];
const COUNTRY_EDGE_ALIASES = new Set();
for (const [code, name, aliases, codes] of COUNTRY_DEFINITIONS) {
  for (const token of codes) {
    const key = normalize(token);
    COUNTRY_CODE_TOKEN.set(key, code);
    COUNTRY_EDGE_ALIASES.add(key);
  }
  for (const alias of [name, ...aliases]) {
    const key = normalize(alias);
    if (key) {
      COUNTRY_NAME_ALIASES.push([key, code]);
      COUNTRY_EDGE_ALIASES.add(key);
    }
  }
}
COUNTRY_NAME_ALIASES.sort((a, b) => b[0].length - a[0].length);
const COUNTRY_EDGE_ALIAS_LIST = [...COUNTRY_EDGE_ALIASES].sort((a, b) => b.length - a.length);

const PREFIX_RE = new RegExp(
  `^\\s*(?:${[...COUNTRY_CODE_TOKEN.keys()].sort((a,b)=>b.length-a.length).join("|")})\\s*[:|\\-]\\s*`,
  "i",
);

function countryFromName(value) {
  const hay = normalize(value);
  if (!hay) return "";
  const padded = ` ${hay} `;
  for (const [alias, code] of COUNTRY_NAME_ALIASES) {
    if (padded.includes(` ${alias} `)) return code;
  }
  const tokens = hay.split(" ").filter(Boolean);
  return COUNTRY_CODE_TOKEN.get(tokens[0]) || COUNTRY_CODE_TOKEN.get(tokens[tokens.length - 1]) || "";
}

function countryFromId(value) {
  const tokens = String(value || "").toLowerCase().split(/[._-]+/).map(normalize).filter(Boolean);
  if (!tokens.length) return "";
  return COUNTRY_CODE_TOKEN.get(tokens[tokens.length - 1]) || COUNTRY_CODE_TOKEN.get(tokens[0]) || "";
}

export function stripCountryDecoration(value) {
  let base = normalize(value);
  if (!base) return "";
  const aliases = COUNTRY_EDGE_ALIAS_LIST;
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (base.startsWith(`${alias} `) && base.length > alias.length) {
        base = base.slice(alias.length + 1).trim();
        changed = true;
        break;
      }
      if (base.endsWith(` ${alias}`) && base.length > alias.length) {
        base = base.slice(0, -(alias.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return base;
}

export function countryName(code) {
  return COUNTRY_BY_CODE.get(String(code || "").toUpperCase())?.name || "";
}

export function countryGroup(code) {
  const cc = String(code || "").toUpperCase();
  if (cc === "GB") return "TV | UK";
  if (cc === "PT") return "TV | PT";
  if (cc === "US") return "TV | USA";
  const name = countryName(cc);
  return name ? `TV | ${name}` : "TV | International";
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
  // Explicit country information in a channel name/tvg-name outranks broad
  // provider grouping. Two-letter codes are only interpreted as boundary
  // tokens or separated tvg-id tokens, avoiding false positives such as "in".
  const byName = countryFromName(`${row.name || ""} ${row.tvgName || ""}`);
  if (byName) return byName;

  const byId = countryFromId(row.tvgId);
  if (byId) return byId;

  return countryFromName(row.group || "");
}

export function canonicalGroup(row) {
  return countryGroup(countryOf(row));
}

export function variantRank(variant, qualityOrder) {
  const q = qualityOrder.indexOf(variant.quality);
  const quality = q === -1 ? qualityOrder.length : q;
  return quality * 2 + (variant.backup ? 1 : 0);
}
