import { compareCountryChannels } from "./country-order.js";
import { config, withKey } from "./config.js";

const HOUR = 60 * 60 * 1000;
const PRIORITY_COUNTRIES = ["US", "GB", "PT"];
const SPECIAL_NAMES = new Map([
  ["US", "USA"],
  ["GB", "UK"],
  ["PT", "Portugal"],
]);

const COUNTRY_SUFFIXES = new Map([
  ["US", ["USA", "US", "United States"]],
  ["GB", ["UK", "GB", "United Kingdom"]],
  ["PT", ["Portugal", "PT"]],
  ["CA", ["Canada", "CA"]],
  ["ES", ["Spain", "ES"]],
  ["FR", ["France", "FR"]],
  ["DE", ["Germany", "DE"]],
  ["IT", ["Italy", "IT"]],
  ["NL", ["Netherlands", "NL"]],
  ["IE", ["Ireland", "IE"]],
  ["AU", ["Australia", "AU"]],
  ["BR", ["Brazil", "BR"]],
]);

const SPORT_GROUPS = [
  { key: "football", label: "Sports | Football", re: /\b(?:football|soccer|premier league|champions league|europa league|conference league|uefa|fifa|la liga|bundesliga|serie a|ligue 1|mls|league one|league two|efl championship|premiership|primera divisi[oó]n|brasileir[aã]o|eredivisie|primeira liga|liga portugal|libertadores|sudamericana|fa cup|carabao)\b/i },
  { key: "motorsport", label: "Sports | Motorsport", re: /\b(?:formula ?1|f1|motogp|moto ?gp|nascar|indycar|motorsport|superbike|racing|grand prix|gran premio)\b/i },
  { key: "combat", label: "Sports | Boxing & MMA", re: /\b(?:boxing|mma|ufc|bellator|combat|fight|wwe|aew|wrestling)\b/i },
  { key: "tennis", label: "Sports | Tennis", re: /\b(?:tennis|atp|wta|wimbledon|roland garros|australian open|us open)\b/i },
  { key: "basketball", label: "Sports | Basketball", re: /\b(?:basketball|nba|wnba|euroleague|fiba)\b/i },
  { key: "american-football", label: "Sports | American Football", re: /\b(?:american football|nfl|college football|ncaa football|cfl)\b/i },
  { key: "baseball", label: "Sports | Baseball", re: /\b(?:baseball|mlb)\b/i },
  { key: "hockey", label: "Sports | Ice Hockey", re: /\b(?:ice hockey|nhl|hockey)\b/i },
  { key: "golf", label: "Sports | Golf", re: /\b(?:golf|pga|lpga|ryder cup|solheim)\b/i },
  { key: "rugby", label: "Sports | Rugby", re: /\b(?:rugby|six nations)\b/i },
  { key: "cricket", label: "Sports | Cricket", re: /\b(?:cricket|ipl|t20|test match)\b/i },
  { key: "cycling", label: "Sports | Cycling", re: /\b(?:cycling|tour de france|giro d['’]italia|vuelta|stage \d+)\b/i },
  { key: "water", label: "Sports | Water Sports", re: /\b(?:surf|world surf league|wsl tour|canoe|kayak|rowing|sailing|swimming|diving|water polo)\b/i },
  { key: "athletics", label: "Sports | Athletics", re: /\b(?:athletics|track and field|marathon)\b/i },
];

const SPORT_FALLBACK = { key: "other", label: "Sports | Other" };
const LINEAR_SPORTS_RE = /\b(?:sky\s+sports|tnt\s+sports|bt\s+sport|espn|sport\s*tv|dazn|eurosport|be?in\s+sports?|fox\s+sports?|fs\s*[12]|nbc\s+sports?|cbs\s+sports?|canal\+?\s*sport|supersport|tsn|sportsnet|nfl\s+network|nba\s+tv|mlb\s+network|nhl\s+network|golf\s+channel|premier\s+sports?|viaplay\s+sports?|optus\s+sport|stan\s+sport|arena\s+sport|ziggo\s+sport|movistar\s+deportes)\b/i;
const SOURCE_SUFFIX_RE = /\b(?:backup|event|stream|feed|ppv|main\s+event)\b/i;
const EVENT_SIGNAL_RE = /(?:\b(?:vs\.?|v\.?)\b|@|\s:\s|\b(?:day|stage|round|session|heat|race|qualifying|practice)\s*\d+\b|\b(?:semi-?final|quarter-?final|final)\b|\bworld championships?\b|\bchampionship tour\b|\bvarious events\b|\bgrand prix\b|\bgran premio\b|\bppv\b)/i;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const displayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeCountryCode(code, name = "") {
  const title = String(name || "").trim();
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
  const clean = original
    .replace(/\b(?:portugal|pt)\b/gi, " ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const rebrand = /^(?:(?:eleven(?:\s+sports)?)|(?:dazn\s+eleven))\s*([1-6])$/i.exec(clean);
  return rebrand ? `DAZN ${rebrand[1]}` : original;
}

function cleanChannelName(country, name) {
  const cc = normalizeCountryCode(country, name);
  let out = currentChannelName(cc, name)
    .replace(/\s+[—–]\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  for (const suffix of COUNTRY_SUFFIXES.get(cc) || []) {
    const re = new RegExp(`\\s+${escaped(suffix)}(?=\\s*(?:UHD|FHD|HD|SD|4K|1080P|720P)?$)`, "i");
    out = out.replace(re, "").replace(/\s+/g, " ").trim();
  }
  return out;
}

function replaceableLegacyLogo(url) {
  const value = String(url || "").trim();
  if (!value) return value;
  const join = value.includes("?") ? "&" : "?";
  return `${value}${join}justone-rebrand=1`;
}

function sportMatch(value) {
  return SPORT_GROUPS.find((item) => item.re.test(String(value || ""))) || null;
}

export function isSportsEvent(channel) {
  if (channel?.kind === "sport-slot") return true;
  const name = String(channel?.name || channel?.tvgName || "").trim();
  if (!name) return false;
  if (EVENT_SIGNAL_RE.test(name)) return true;
  if (name.includes("|") && /\b20\d{2}\b/.test(name) && sportMatch(name)) return true;
  const group = String(channel?.group || "");
  if (/\b(?:event|ppv)\b/i.test(group)) return true;
  return false;
}

export function isLinearSportsChannel(channel) {
  const name = String(channel?.name || channel?.tvgName || "").trim();
  if (isSportsEvent(channel)) return false;
  const head = name.split(/\s+(?:—|–|-)\s+/)[0] || name;
  return LINEAR_SPORTS_RE.test(head);
}

function sportGroup(channel) {
  const name = String(channel?.name || "");
  const group = String(channel?.group || "");
  const programmeText = (channel?.programmes || [])
    .flatMap((programme) => [programme?.title, programme?.subtitle, ...(programme?.categories || [])])
    .filter(Boolean)
    .join(" ");
  const hay = `${group} ${name} ${programmeText}`;

  if (channel?.kind === "sport-slot") return sportMatch(hay) || SPORT_FALLBACK;
  if (isLinearSportsChannel(channel)) return null;

  const explicitGroup = sportMatch(group);
  if (explicitGroup) return explicitGroup;

  const direct = sportMatch(hay);
  if (isSportsEvent(channel)) return direct || SPORT_FALLBACK;
  if (/\b(?:sports?|event|ppv)\b/i.test(group)) return direct || SPORT_FALLBACK;
  return null;
}

function isExplicit247(channel) {
  return /(?:^|\b)24\s*\/\s*7(?:\b|$)/i.test(`${channel?.group || ""} ${channel?.name || ""}`);
}

function preparedChannel(channel) {
  const country = normalizeCountryCode(channel.country, channel.name);
  const name = cleanChannelName(country, channel.name);
  const rebranded = currentChannelName(country, channel.name) !== String(channel.name || "").trim();
  return {
    ...channel,
    country,
    name,
    logo: rebranded ? replaceableLegacyLogo(channel.logo) : channel.logo,
    rebrandedFrom: rebranded ? channel.name : channel.rebrandedFrom,
  };
}

function eventTitle(channel) {
  const name = String(channel?.name || "").trim();
  const parts = name.split(/\s+(?:—|–|-)\s+/);
  if (parts.length < 2) return name;
  const tail = parts.slice(1).join(" - ");
  if (LINEAR_SPORTS_RE.test(tail) || SOURCE_SUFFIX_RE.test(tail)) return parts[0].trim();
  return name;
}

function compareSportChannels(a, b) {
  const byEvent = collator.compare(eventTitle(a), eventTitle(b));
  if (byEvent !== 0) return byEvent;
  return collator.compare(String(a?.name || ""), String(b?.name || ""));
}

function sortCountries(countries) {
  return [...countries].sort((a, b) => {
    const ra = countryRank(a);
    const rb = countryRank(b);
    if (ra !== rb) return ra - rb;
    if (!a) return 1;
    if (!b) return -1;
    return countryLabel(a).localeCompare(countryLabel(b));
  });
}

function artworkUrl(variant, token) {
  return withKey(`${config.publicUrl}/jellyfin/artwork/${variant}/${encodeURIComponent(token)}.png`);
}

function eventProgrammes(channel, sport) {
  const category = sport.label.replace(/^Sports\s*\|\s*/i, "") || "Sports";
  const existing = Array.isArray(channel.programmes) ? channel.programmes : [];
  const base = existing.length ? existing : [{
    start: Math.floor(Date.now() / (6 * HOUR)) * 6 * HOUR,
    end: Math.floor(Date.now() / (6 * HOUR)) * 6 * HOUR + 12 * HOUR,
    title: eventTitle(channel),
    subtitle: category,
    categories: ["Sports", category],
  }];
  return base.map((programme, index) => ({
    ...programme,
    title: programme.title || eventTitle(channel),
    subtitle: programme.subtitle || category,
    categories: [...new Set(["Sports", category, ...(programme.categories || [])])],
    icon: artworkUrl("program", `${channel.id}.event.${index}`),
  }));
}

function styleSportsEvent(channel, sport) {
  return {
    ...channel,
    kind: "sport-slot",
    eventStyle: true,
    iptvOrgId: "",
    logo: artworkUrl("channel", channel.id),
    logoSource: "generated-sports-event",
    programmes: eventProgrammes(channel, sport),
  };
}

export function organizeLineup(lineup) {
  const prepared = (lineup || []).map(preparedChannel);
  const sports = [];
  const alwaysOn = [];
  const television = [];
  for (const channel of prepared) {
    const sport = sportGroup(channel);
    if (sport) sports.push({ channel, sport });
    else if (isExplicit247(channel)) alwaysOn.push(channel);
    else television.push(channel);
  }

  const ordered = [];
  SPORT_GROUPS.concat(SPORT_FALLBACK).forEach((sport, sportIndex) => {
    const rows = sports
      .filter((entry) => entry.sport.key === sport.key)
      .map((entry) => styleSportsEvent(entry.channel, sport))
      .sort(compareSportChannels);
    rows.forEach((channel, index) => {
      ordered.push({ ...channel, group: sport.label, number: (sportIndex + 1) * 1000 + index + 1 });
    });
  });

  const countries = sortCountries(new Set(television.map((channel) => channel.country)));
  countries.forEach((country, countryIndex) => {
    const rows = television
      .filter((channel) => channel.country === country)
      .sort((a, b) => compareCountryChannels(country, a, b));
    rows.forEach((channel, index) => {
      ordered.push({ ...channel, group: `TV | ${countryLabel(country)}`, number: 20000 + countryIndex * 1000 + index + 1 });
    });
  });

  const alwaysOnCountries = sortCountries(new Set(alwaysOn.map((channel) => channel.country)));
  alwaysOnCountries.forEach((country, countryIndex) => {
    const rows = alwaysOn
      .filter((channel) => channel.country === country)
      .sort((a, b) => compareCountryChannels(country, a, b));
    rows.forEach((channel, index) => {
      ordered.push({ ...channel, group: country ? `24/7 | ${countryLabel(country)}` : "24/7", number: 80000 + countryIndex * 1000 + index + 1 });
    });
  });

  return ordered;
}
