import { chooseChannelLogo } from "./channel-logos.js";
import { countrySuffixes as identityCountrySuffixes, normalizeCountryCode } from "./channel-identity.js";
import { config, withKey } from "./config.js";

const docIndexCache = new WeakMap();
const HOUR = 60 * 60 * 1000;
const QUARTER_HOUR = 15 * 60 * 1000;
export const EPG_HORIZON_HOURS = 24;
const EPG_HORIZON_MS = EPG_HORIZON_HOURS * HOUR;

const EXPLICIT_ALIASES = new Map([
  ["PT|rtp 3", ["rtp noticias"]],
  ["US|nesn", ["new england sports"]],
  ["US|masn", ["masn mid atlantic sports"]],
  ["US|msg", ["msg national"]],
  ["US|nbc universo", ["universo"]],
  ["US|wetv", ["we"]],
  ["US|showtime family zone sho family zone", ["showtime familyzone"]],
  ["US|cbs", ["cbs streaming east"]],
  ["US|nbc", ["nbc east stream"]],
  ["US|pbs", ["pbs stream"]],
  ["US|mgm usa epix", ["mgm"]],
]);

function xml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeEntities(value) {
  let out = String(value || "");
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, " ").trim();
}

function normalizeCountry(value) {
  return normalizeCountryCode(value);
}

function sourceCountry(url) {
  const m = /epg_ripper_([A-Z]{2})(?:\d|_)/i.exec(String(url || ""));
  return m ? normalizeCountry(m[1]) : "";
}

function countrySuffixes(country) {
  return identityCountrySuffixes(country);
}

export function canonicalGuideName(value, country = "") {
  let s = decodeEntities(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/\bskysp\b/g, "sky sports")
    .replace(/\bnetwrk\b/g, "network")
    .replace(/\bfball\b/g, "football")
    .replace(/\bmain ev\b/g, "main event")
    .replace(/\bsp\b(?=\s+(?:f1|football|cricket|golf|racing|tennis|mix|news|action))/g, "sports")
    .replace(/[._/\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    // Split genuine channel-number/quality joins such as Sports4, Eurosport1,
    // ITV1 and 4HD, but keep one-letter numbered brands such as F1 intact.
    .replace(/([a-z]{2,})(\d)/g, "$1 $2")
    .replace(/(\d)([a-z]{2,})/g, "$1 $2")
    .replace(/\bnova\s+sports?\b/g, "novasports")
    .replace(/\bcyta\s+vision\b/g, "cytavision")
    .replace(/\s+/g, " ")
    .trim();

  // Quality is commonly appended after the country ("Greece HD"). Remove it
  // before stripping the country suffix so ordinary regional channels match.
  s = s
    .replace(/\b(?:uhd|fhd|hd|sd|2160p|1080p|720p|576p|480p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const suffix of countrySuffixes(country)) {
    const re = new RegExp(`\\s+${suffix.replace(/\s+/g, "\\s+")}$`, "i");
    if (re.test(s)) s = s.replace(re, "").trim();
  }

  return s
    .replace(/\b(?:east feed|west feed|pacific feed|national feed)\b/g, " ")
    .replace(/\b(?:channel|network|television)\b/g, " ")
    .replace(/\btv\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guideKeys(value, country = "") {
  const raw = decodeEntities(value);
  const values = [raw, raw.replace(/\([^)]*\)/g, " ")];
  const out = new Set();
  for (const item of values) {
    const canonical = canonicalGuideName(item, country);
    if (!canonical) continue;
    out.add(canonical);
    const compact = canonical.replace(/\s+/g, "");
    if (compact.length >= 3) out.add(compact);
    const singularSport = canonical.replace(/\bsports\b/g, "sport");
    if (singularSport !== canonical) {
      out.add(singularSport);
      const singularCompact = singularSport.replace(/\s+/g, "");
      if (singularCompact.length >= 3) out.add(singularCompact);
    }
  }
  return [...out];
}

function addAlias(map, key, id) {
  if (!key) return;
  const set = map.get(key) || new Set();
  set.add(id);
  map.set(key, set);
}

function indexDoc(doc) {
  const cached = docIndexCache.get(doc);
  if (cached) return cached;
  const country = sourceCountry(doc.sourceUrl);
  const aliases = new Map();
  const byToken = new Map();
  const entries = new Map();

  for (const [id, meta] of doc.channels || []) {
    const names = [id, ...(meta.display || [])];
    const canonical = [...new Set(names.flatMap((n) => guideKeys(n, country)).filter(Boolean))];
    const tokenSet = new Set(canonical.flatMap((n) => n.split(" ")).filter(Boolean));
    entries.set(id, { id, meta, canonical, tokens: tokenSet });
    for (const name of canonical) addAlias(aliases, name, id);
    for (const token of tokenSet) {
      if (token.length < 3) continue;
      const set = byToken.get(token) || new Set();
      set.add(id);
      byToken.set(token, set);
    }
  }

  const out = { country, aliases, byToken, entries };
  docIndexCache.set(doc, out);
  return out;
}

function channelVariants(ch) {
  const country = normalizeCountry(ch.country);
  const raw = [
    ch.name,
    ch.tvgId,
    ch.iptvOrgId,
    ...(ch.sourceTvgIds || []),
    ...(ch.candidates || []).map((candidate) => candidate?.label),
  ].filter((v) => v && !/^justone\./i.test(v) && !/^dlhd-/i.test(v));

  const out = new Set(raw.flatMap((v) => guideKeys(v, country)));
  for (const key of [...out]) {
    for (const alias of EXPLICIT_ALIASES.get(`${country}|${key}`) || []) {
      for (const expanded of guideKeys(alias, country)) out.add(expanded);
    }
  }
  return [...out].filter(Boolean);
}

function numberTokens(value) {
  return [...String(value || "").matchAll(/\b\d{1,4}\b/g)].map((m) => Number(m[0]));
}

function channelNumbersCompatible(a, b) {
  const aa = numberTokens(a);
  const bb = numberTokens(b);
  if (!aa.length && !bb.length) return true;
  if (aa.length !== bb.length) return false;
  return aa.every((value, index) => value === bb[index]);
}

function similarity(a, entry) {
  const aa = new Set(a.split(" ").filter(Boolean));
  if (!aa.size) return 0;
  let best = 0;
  for (const b of entry.canonical) {
    // Numbered families are not interchangeable. Cytavision Sports 4 must not
    // fuzzy-match Sports 1/2/3/5 simply because the broadcaster words overlap.
    if (!channelNumbersCompatible(a, b)) continue;
    if (a === b) return 100;
    const bb = new Set(b.split(" ").filter(Boolean));
    const intersection = [...aa].filter((x) => bb.has(x)).length;
    if (!intersection) continue;
    const smaller = Math.min(aa.size, bb.size);
    const larger = Math.max(aa.size, bb.size);
    const containment = intersection / smaller;
    const jaccard = intersection / (aa.size + bb.size - intersection);

    if (aa.size === 1 || bb.size === 1) {
      const onlyA = [...aa][0] || "";
      const onlyB = [...bb][0] || "";
      if (containment === 1 && onlyA.length >= 4 && onlyB.length >= 4) best = Math.max(best, 92);
      continue;
    }
    if (containment === 1) best = Math.max(best, 94 - Math.max(0, larger - smaller) * 3);
    else if (jaccard >= 0.75) best = Math.max(best, 88);
    else if (jaccard >= 0.6 && intersection >= 2) best = Math.max(best, 84);
  }
  return best;
}

function candidateIds(index, variant) {
  const exact = index.aliases.get(variant);
  if (exact?.size) return [...exact];
  const t = variant.split(" ").filter((x) => x.length >= 3);
  if (!t.length) return [];
  t.sort((a, b) => b.length - a.length);
  const candidates = new Set();
  for (const token of t.slice(0, 3)) {
    for (const id of index.byToken.get(token) || []) candidates.add(id);
  }
  return [...candidates];
}

export function matchGuideChannel(ch, docs) {
  const variants = channelVariants(ch);
  if (!variants.length) return null;
  const country = normalizeCountry(ch.country);
  const orderedDocs = [...(docs || [])].sort((a, b) => {
    const ac = indexDoc(a).country === country ? 0 : 1;
    const bc = indexDoc(b).country === country ? 0 : 1;
    return ac - bc;
  });

  let best = null;
  for (const doc of orderedDocs) {
    const index = indexDoc(doc);
    // A known country-specific EPG pack is a hard boundary and must never be
    // used for another country. Country is resolved before channel name/number.
    if (country && index.country && country !== index.country) continue;
    for (const variant of variants) {
      for (const id of candidateIds(index, variant)) {
        const entry = index.entries.get(id);
        if (!entry) continue;
        const score = similarity(variant, entry);
        if (!score) continue;
        const programmeCount = (doc.programmes?.get(id) || []).length;
        const isBetter = !best
          || score > best.score
          || (programmeCount > 0 && best.programmeCount === 0 && score >= best.score - 4)
          || (score === best.score && programmeCount > best.programmeCount);
        if (isBetter) best = { doc, id, meta: entry.meta, score, programmeCount };
      }
    }
    if (best?.score >= 98 && best.programmeCount > 0) break;
  }
  return best?.score >= 86 ? best : null;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

export function parseXmltvTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(String(value || "").trim());
  if (!m) return Number.NaN;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (!m[7]) return utc;
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60 * 1000;
  return m[7] === "+" ? utc - offset : utc + offset;
}

export function externalProgramBounds(full) {
  const start = parseXmltvTime(/\bstart="([^"]+)"/i.exec(String(full || ""))?.[1]);
  const stop = parseXmltvTime(/\bstop="([^"]+)"/i.exec(String(full || ""))?.[1]);
  return { start, stop };
}

export function programmeInWindow(full, now, horizonEnd = now + EPG_HORIZON_MS) {
  const { start, stop } = externalProgramBounds(full);
  if (!Number.isFinite(start)) return false;
  const effectiveStop = Number.isFinite(stop) && stop > start ? stop : start + HOUR;
  return effectiveStop > now && start < horizonEnd;
}

function externalProgrammeTitle(full) {
  const value = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(full || ""))?.[1] || "";
  return decodeEntities(value.replace(/<[^>]+>/g, " "));
}

export function isIdleExternalProgramme(full) {
  const title = externalProgrammeTitle(full)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return false;
  return [
    /\bprestavka\s+(?:ve|vo)\s+vysilani\b/,
    /\boff\s+air\b/,
    /\bbroadcast\s+break\b/,
    /\btransmission\s+break\b/,
    /\bnot\s+broadcasting\b/,
    /\bno\s+(?:data|information|programme\s+information|program\s+information)\b/,
    /\b(?:programme|programming)\s+unavailable\b/,
  ].some((pattern) => pattern.test(title));
}

function localArtwork(ch, variant = "program") {
  return withKey(`${config.publicUrl}/jellyfin/artwork/${variant}/${encodeURIComponent(ch.id)}.png`);
}

function eventParts(title, fallbackCategory = "Sports") {
  const clean = decodeEntities(title);
  const colon = clean.indexOf(":");
  const competition = colon > 0 ? clean.slice(0, colon).trim() : "";
  const event = colon > 0 ? clean.slice(colon + 1).trim() : clean;
  const match = /^(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+)$/i.exec(event);
  return {
    clean,
    competition,
    teamA: match?.[1]?.trim() || "",
    teamB: match?.[2]?.trim() || "",
    category: decodeEntities(fallbackCategory),
  };
}

function generatedSportsProgramXml(ch, p) {
  const parts = eventParts(p.title, p.categories?.[1] || p.subtitle || "Sports");
  const subtitle = parts.competition || decodeEntities(p.subtitle || "");
  const desc = parts.teamA && parts.teamB
    ? `${parts.teamA} vs ${parts.teamB}${subtitle ? ` • ${subtitle}` : ""}`
    : `${parts.clean}${subtitle && subtitle !== parts.clean ? ` • ${subtitle}` : ""}`;
  const categories = [...new Set(["Sports", ...(p.categories || []).map(decodeEntities).filter(Boolean)])];
  return [
    `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="${xml(ch.tvgId)}">`,
    `    <title>${xml(parts.clean)}</title>`,
    subtitle ? `    <sub-title>${xml(subtitle)}</sub-title>` : "",
    `    <desc>${xml(desc)}</desc>`,
    ...categories.map((c) => `    <category>${xml(c)}</category>`),
    parts.teamA ? `    <keyword>${xml(parts.teamA)}</keyword>` : "",
    parts.teamB ? `    <keyword>${xml(parts.teamB)}</keyword>` : "",
    p.icon ? `    <icon src="${xml(p.icon)}" />` : "",
    p.icon ? `    <image type="backdrop" size="3" orient="L">${xml(p.icon)}</image>` : "",
    "  </programme>",
  ].filter(Boolean).join("\n");
}

function fallbackLiveProgramXml(ch, now = Date.now()) {
  const start = Math.floor(now / QUARTER_HOUR) * QUARTER_HOUR;
  const end = start + 6 * HOUR;
  const channelName = decodeEntities(ch.name) || "Live TV";
  const image = ch.logo || localArtwork(ch, "program");
  return [
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xml(ch.tvgId)}">`,
    "    <title>Schedule unavailable</title>",
    `    <sub-title>${xml(channelName)}</sub-title>`,
    `    <desc>${xml(channelName)} is live. Detailed programme schedule is currently unavailable.</desc>`,
    "    <category>Live TV</category>",
    `    <icon src="${xml(image)}" />`,
    `    <image type="backdrop" size="3" orient="L">${xml(image)}</image>`,
    "  </programme>",
  ].join("\n");
}

function adaptExternalProgram(full, ch, hit) {
  let out = String(full).replace(/\bchannel="[^"]+"/i, `channel="${xml(ch.tvgId)}"`);
  const fallback = ch.logo || hit?.meta?.icon || localArtwork(ch, "program");
  let image = /<icon\b[^>]*\bsrc="([^"]+)"/i.exec(out)?.[1] || "";
  if (!image) {
    out = out.replace(/<\/programme>/i, `  <icon src="${xml(fallback)}" />\n</programme>`);
    image = fallback;
  }
  if (!/<image\b/i.test(out) && image) {
    out = out.replace(/<\/programme>/i, `  <image type="backdrop" size="3" orient="L">${xml(image)}</image>\n</programme>`);
  }
  return out;
}

export function guideCoverage(lineup, docs) {
  let staticChannels = 0;
  let matchedChannels = 0;
  let channelsWithPrograms = 0;
  let guideLogosApplied = 0;
  let generatedLogosRemaining = 0;
  let existingLogosKept = 0;
  const countryBuckets = new Map();

  for (const ch of lineup || []) {
    if (ch.kind !== "static") continue;
    staticChannels += 1;
    const country = normalizeCountry(ch.country) || "INTL";
    const bucket = countryBuckets.get(country) || { staticChannels: 0, matchedChannels: 0, channelsWithPrograms: 0 };
    bucket.staticChannels += 1;

    const hit = matchGuideChannel(ch, docs);
    const logoChoice = chooseChannelLogo(ch.logo, hit?.meta?.icon);
    if (logoChoice.changed) {
      ch.logo = logoChoice.logo;
      ch.logoSource = logoChoice.source;
      guideLogosApplied += 1;
    } else if (logoChoice.source === "generated") {
      generatedLogosRemaining += 1;
    } else {
      existingLogosKept += 1;
    }

    if (hit) {
      matchedChannels += 1;
      bucket.matchedChannels += 1;
      if ((hit.doc.programmes?.get(hit.id) || []).some((p) => !isIdleExternalProgramme(p))) {
        channelsWithPrograms += 1;
        bucket.channelsWithPrograms += 1;
      }
    }
    countryBuckets.set(country, bucket);
  }

  const byCountry = Object.fromEntries([...countryBuckets.entries()]
    .sort((a, b) => b[1].staticChannels - a[1].staticChannels || a[0].localeCompare(b[0]))
    .map(([country, row]) => [country, {
      ...row,
      coveragePercent: row.staticChannels ? Math.round((row.channelsWithPrograms / row.staticChannels) * 1000) / 10 : 0,
    }]));

  return {
    staticChannels,
    matchedChannels,
    channelsWithPrograms,
    coveragePercent: staticChannels ? Math.round((channelsWithPrograms / staticChannels) * 1000) / 10 : 0,
    guideLogosApplied,
    generatedLogosRemaining,
    existingLogosKept,
    byCountry,
  };
}

function isEventChannel(ch) {
  return ch?.kind === "sport-slot" || ch?.eventFailover === true || ch?.eventStyle === true;
}

export function buildXmlTv(lineup, docs = [], { now = Date.now(), horizonHours = EPG_HORIZON_HOURS } = {}) {
  const horizonEnd = now + Math.max(1, Number(horizonHours || EPG_HORIZON_HOURS)) * HOUR;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="JustOne Jellyfin Live">',
  ];
  const hits = new Map();

  // Only final lineup channels are emitted. Upstream guide-only channels never
  // enter the final XMLTV, which keeps M3U and EPG identities in lockstep.
  for (const ch of lineup || []) {
    const hit = ch.kind === "static" && !isEventChannel(ch) ? matchGuideChannel(ch, docs) : null;
    if (hit) hits.set(ch.id, hit);
    const icon = ch.logo || hit?.meta?.icon || localArtwork(ch, "channel");
    lines.push(`  <channel id="${xml(ch.tvgId)}">`);
    lines.push(`    <display-name>${xml(decodeEntities(ch.name))}</display-name>`);
    lines.push(`    <icon src="${xml(icon)}" />`);
    lines.push("  </channel>");
  }

  for (const ch of lineup || []) {
    if (isEventChannel(ch)) {
      const programmes = (ch.programmes || []).filter((p) => {
        const start = Number(p?.start);
        const stop = Number(p?.end);
        // Only the verified DLStreams event entry is emitted. There are no
        // filler programmes before or after it, so idle event channels remain
        // completely absent from Jellyfin's current-programme surfaces.
        return p?.scheduleSource === "dlstreams"
          && Number.isFinite(start)
          && Number.isFinite(stop)
          && stop > now
          && start < horizonEnd;
      });
      for (const p of programmes) lines.push(generatedSportsProgramXml(ch, p));
      continue;
    }

    const hit = hits.get(ch.id);
    const scheduledExternal = (hit?.doc?.programmes?.get(hit.id) || [])
      .filter((p) => programmeInWindow(p, now, horizonEnd));
    const external = scheduledExternal.filter((p) => !isIdleExternalProgramme(p));
    if (external.length) {
      for (const p of external) lines.push(adaptExternalProgram(p, ch, hit));
    } else if (scheduledExternal.length) {
      // The upstream guide explicitly says this channel is idle/off-air. Leave
      // the XMLTV gap empty rather than turning that filler into a Jellyfin
      // Home-screen item or replacing it with our own schedule placeholder.
      continue;
    } else {
      // Keep unmatched linear channels usable without pretending that the
      // placeholder time is a real programme start. The title explicitly says
      // the schedule is unavailable and the block begins at the current
      // quarter-hour instead of a fixed 6-hour boundary such as 07:00 BST.
      lines.push(fallbackLiveProgramXml(ch, now));
    }
  }

  lines.push("</tv>");
  return lines.join("\n") + "\n";
}