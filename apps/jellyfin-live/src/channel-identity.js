const COUNTRY_ALIASES = new Map([
  ["US", ["usa", "us", "united states", "united states of america"]],
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

export function channelIdentityKeys(value, country = "") {
  const out = new Set();
  const exact = stripCountrySuffix(normalizedWords(value), country);
  addKey(out, exact);

  // Provider quality suffixes are often presentation noise. Keep the exact key
  // first so real channel variants such as a dedicated 4K service can still win.
  const withoutQuality = exact
    .replace(/\b(?:uhd|fhd|hd|sd|2160p|1080p|720p|576p|480p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  addKey(out, withoutQuality);

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
