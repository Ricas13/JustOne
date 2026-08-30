import { compareCountryChannels } from "./country-order.js";

const PRIORITY_COUNTRIES = ["US", "GB", "PT"];
const SPECIAL_NAMES = new Map([
  ["US", "USA"],
  ["GB", "UK"],
  ["PT", "Portugal"],
]);

const displayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

export function normalizeCountryCode(code, name = "") {
  const title = String(name || "").trim();

  // These names are easy to misclassify from the word "USA" / source grouping.
  // 5USA is a UK channel, while BBC America is a US channel.
  if (/^5\s*USA$/i.test(title)) return "GB";
  if (/^BBC\s+America\b/i.test(title)) return "US";

  const cc = String(code || "").trim().toUpperCase();
  if (cc === "UK") return "GB";
  if (cc === "USA") return "US";
  return cc;
}

export function countryLabel(code) {
  const cc = normalizeCountryCode(code);
  if (!cc) return "International";
  if (SPECIAL_NAMES.has(cc)) return SPECIAL_NAMES.get(cc);
  try {
    return displayNames?.of(cc) || cc;
  } catch {
    return cc;
  }
}

function countryRank(code) {
  const cc = normalizeCountryCode(code);
  const preferred = PRIORITY_COUNTRIES.indexOf(cc);
  return preferred >= 0 ? preferred : 100;
}

export function currentChannelName(country, name) {
  const cc = normalizeCountryCode(country, name);
  const original = String(name || "").trim();
  if (cc !== "PT") return original;

  // Eleven's Portuguese linear channels were rebranded under DAZN. Keep this
  // Portugal-only so Eleven-branded services in other countries are untouched.
  const clean = original
    .replace(/\b(?:portugal|pt)\b/gi, " ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const rebrand = /^(?:(?:eleven(?:\s+sports)?)|(?:dazn\s+eleven))\s*([1-6])$/i.exec(clean);
  return rebrand ? `DAZN ${rebrand[1]}` : original;
}

export function organizeLineup(lineup) {
  const sports = (lineup || [])
    .filter((ch) => ch.kind === "sport-slot")
    .sort((a, b) => Number(a.number || 0) - Number(b.number || 0) || String(a.name).localeCompare(String(b.name)));

  const statics = (lineup || [])
    .filter((ch) => ch.kind === "static")
    .map((ch) => {
      const country = normalizeCountryCode(ch.country, ch.name);
      return { ...ch, country, name: currentChannelName(country, ch.name) };
    });

  const countries = [...new Set(statics.map((ch) => ch.country))]
    .sort((a, b) => {
      const ra = countryRank(a);
      const rb = countryRank(b);
      if (ra !== rb) return ra - rb;
      if (!a) return 1;
      if (!b) return -1;
      return countryLabel(a).localeCompare(countryLabel(b));
    });

  const ordered = [];
  countries.forEach((country, countryIndex) => {
    const rows = statics
      .filter((ch) => ch.country === country)
      .sort((a, b) => compareCountryChannels(country, a, b));
    const base = (countryIndex + 1) * 1000;
    rows.forEach((ch, i) => {
      ordered.push({
        ...ch,
        group: countryLabel(country),
        number: base + i,
      });
    });
  });

  return [...sports, ...ordered];
}
