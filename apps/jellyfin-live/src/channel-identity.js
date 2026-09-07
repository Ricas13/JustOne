const COUNTRY_ALIASES = new Map([
  ["US", ["usa", "us", "us2", "us 2", "united states", "united states of america"]],
  ["GB", ["uk", "gb", "united kingdom", "great britain", "england", "scotland", "wales"]],
  ["PT", ["pt", "portugal"]],
  ["GR", ["gr", "greece", "hellas"]],
  ["FR", ["fr", "france"]],
  ["DK", ["dk", "denmark"]],
  ["CY", ["cy", "cyprus"]],
  ["CA", ["ca", "canada"]],
  ["ES", ["es", "spain"]],
  ["DE", ["de", "germany"]],
  ["IT", ["it", "italy"]],
  ["NL", ["nl", "netherlands", "holland"]],
  ["IE", ["ie", "ireland"]],
  ["AU", ["au", "australia"]],
  ["BR", ["br", "brazil"]],
  ["PL", ["pl", "poland"]],
  ["RO", ["ro", "romania"]],
  ["TR", ["tr", "turkey", "turkiye", "türkiye"]],
  ["SE", ["se", "sweden"]],
  ["NO", ["no", "norway"]],
  ["FI", ["fi", "finland"]],
  ["AT", ["at", "austria"]],
  ["CH", ["ch", "switzerland"]],
  ["BE", ["be", "belgium"]],
  ["CZ", ["cz", "czechia", "czech republic"]],
  ["SK", ["sk", "slovakia"]],
  ["RS", ["rs", "serbia"]],
  ["HR", ["hr", "croatia"]],
  ["SI", ["si", "slovenia"]],
  ["BG", ["bg", "bulgaria"]],
  ["HU", ["hu", "hungary"]],
  ["UA", ["ua", "ukraine"]],
  ["IL", ["il", "israel"]],
  ["AE", ["ae", "uae", "united arab emirates"]],
  ["QA", ["qa", "qatar"]],
  ["SA", ["sa", "saudi arabia", "saudi"]],
  ["ZA", ["za", "south africa"]],
  ["NZ", ["nz", "new zealand"]],
]);

const displayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeCountryCode(value) {
  const cc = String(value || "").trim().toUpperCase();
  if (cc === "UK") return "GB";
  if (cc === "USA") return "US";
  return cc;
}

export function countrySuffixes(country) {
  const cc = normalizeCountryCode(country);
  if (!cc) return [];
  const out = new Set(COUNTRY_ALIASES.get(cc) || []);
  out.add(cc.toLowerCase());
  try {
    const display = displayNames?.of(cc);
    if (display && display !== cc) out.add(String(display).toLowerCase());
  } catch {
    // Unknown/private region code: explicit aliases and the code itself are enough.
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function normalizedWords(value) {
  return decodeEntities(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[._/\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    // Split genuine channel-number/quality joins such as Sports4, Eurosport1,
    // ITV1 and 4HD, but keep one-letter numbered brands such as F1 intact.
    .replace(/([a-z]{2,})(\d)/g, "$1 $2")
    .replace(/(\d)([a-z]{2,})/g, "$1 $2")
    // Provider/guide abbreviations seen in real sports lineups. Keep these in
    // the shared identity layer so EPG and IPTV-org logo matching agree.
    .replace(/\bskysp\b/g, "sky sports")
    .replace(/\bnetwrk\b/g, "network")
    .replace(/\bfball\b/g, "football")
    .replace(/\bmain\s+ev\b/g, "main event")
    .replace(/\bsp\b(?=\s+(?:f1|football|cricket|golf|racing|tennis|mix|news|action))/g, "sports")
    .replace(/\bsporttv\b/g, "sport tv")
    .replace(/\bnova\s+sports?\b/g, "novasports")
    .replace(/\bcyta\s+vision\b/g, "cytavision")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCountrySuffix(value, country) {
  let out = String(value || "").trim();
  for (const suffix of countrySuffixes(country)) {
    const re = new RegExp(`(?:^|\\s)${escaped(suffix).replace(/\\ /g, "\\s+")}$`, "i");
    if (re.test(out)) {
      out = out.replace(re, " ").replace(/\s+/g, " ").trim();
      break;
    }
  }
  return out;
}

function addKey(out, value) {
  const key = String(value || "").replace(/\s+/g, " ").trim();
  if (!key) return;
  out.add(key);
  const compact = key.replace(/\s+/g, "");
  if (compact.length >= 3) out.add(compact);
}

function addCountryBrandAliases(out, country) {
  const cc = normalizeCountryCode(country);
  for (const key of [...out]) {
    if (!key.includes(" ")) continue;

    if (cc === "GB") {
      const skyPl = /^sky sports (?:pl|prem league|premierleague)$/i.exec(key);
      if (skyPl) addKey(out, "sky sports premier league");

      const tnt = /^tnt sports? (\d+)$/i.exec(key);
      if (tnt) {
        addKey(out, `bt sport ${tnt[1]}`);
        addKey(out, `bt sports ${tnt[1]}`);
      }
      const bt = /^bt sports? (\d+)$/i.exec(key);
      if (bt) addKey(out, `tnt sports ${bt[1]}`);
    }

    if (cc === "PT") {
      if (key === "benfica tv") addKey(out, "btv");
      if (key === "sporttv") addKey(out, "sport tv");
    }
  }

  // BTV is a compact brand name, so handle it separately from spaced aliases.
  if (cc === "PT" && out.has("btv")) addKey(out, "benfica tv");
}

export function channelIdentityKeys(value, country = "") {
  const out = new Set();
  const raw = normalizedWords(value);

  // Keep an exact variant first. This preserves meaningful variants while still
  // allowing the common provider form "Channel Greece HD" to normalize by
  // stripping presentation quality before the trailing country marker.
  const exact = stripCountrySuffix(raw, country);
  addKey(out, exact);

  const rawWithoutQuality = raw
    .replace(/\b(?:uhd|fhd|hd|sd|2160p|1080p|720p|576p|480p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutQuality = stripCountrySuffix(rawWithoutQuality, country);
  addKey(out, withoutQuality);

  addCountryBrandAliases(out, country);

  for (const key of [...out]) {
    const words = key.includes(" ") ? key : "";
    if (!words) continue;
    addKey(out, words.replace(/\bsports\b/g, "sport"));
    addKey(out, words.replace(/\btv$/g, "").trim());
  }

  return [...out];
}

export function channelBroadcastCountries(channel) {
  const out = new Set();
  const primary = normalizeCountryCode(channel?.country);
  if (primary) out.add(primary);
  for (const area of channel?.broadcast_area || []) {
    const m = /^c\/([a-z]{2})$/i.exec(String(area || "").trim());
    if (m) out.add(normalizeCountryCode(m[1]));
  }
  return [...out];
}

export function channelCoversCountry(channel, country) {
  const cc = normalizeCountryCode(country);
  if (!cc) return true;
  return channelBroadcastCountries(channel).includes(cc);
}
