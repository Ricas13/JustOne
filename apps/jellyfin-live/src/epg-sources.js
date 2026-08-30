const EPGSHARE_BASE = "https://epgshare01.online/epgshare01/";
const INDEX_TTL_MS = 12 * 60 * 60 * 1000;
const COUNTRY_ALIAS = new Map([["GB", "UK"]]);
const PRIORITY_COUNTRIES = ["US", "UK", "PT"];
const PRIORITY_SUPPLEMENT_PACKS = ["US_SPORTS1"];

let indexCache = { at: 0, files: [] };

function countryKey(country) {
  const cc = String(country || "").trim().toUpperCase();
  return COUNTRY_ALIAS.get(cc) || cc;
}

export function parseEpgShareIndex(html) {
  const seen = new Set();
  const out = [];
  const re = /(?:href=["'])?(epg_ripper_([A-Z0-9_]+)\.xml\.gz)/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const file = m[1];
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({ file, pack: m[2].toUpperCase() });
  }
  return out;
}

function countryCounts(lineup) {
  const counts = new Map();
  for (const ch of lineup || []) {
    if (ch?.kind !== "static") continue;
    const cc = countryKey(ch.country);
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    counts.set(cc, (counts.get(cc) || 0) + 1);
  }
  return counts;
}

function countryOrder(counts) {
  return [...counts.entries()].sort((a, b) => {
    const ap = PRIORITY_COUNTRIES.indexOf(a[0]);
    const bp = PRIORITY_COUNTRIES.indexOf(b[0]);
    if (ap >= 0 || bp >= 0) {
      if (ap < 0) return 1;
      if (bp < 0) return -1;
      return ap - bp;
    }
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
}

function packPriority(pack, cc) {
  if (pack === `${cc}1`) return 0;
  if (pack === `${cc}2`) return 1;
  if (pack.startsWith(`${cc}_SPORTS`)) return 2;
  if (pack.startsWith(`${cc}_`)) return 4;
  return 3;
}

export function selectEpgShareUrls(lineup, availableFiles, maxSources = 12) {
  const limit = Math.max(0, Number(maxSources) || 0);
  if (!limit) return [];
  const counts = countryCounts(lineup);
  const countries = countryOrder(counts);
  const byCountry = new Map();
  const byPack = new Map();

  for (const row of availableFiles || []) {
    const pack = String(row.pack || "").toUpperCase();
    byPack.set(pack, row);
    for (const [cc] of countries) {
      if (!pack.startsWith(cc)) continue;
      const arr = byCountry.get(cc) || [];
      arr.push(row);
      byCountry.set(cc, arr);
      break;
    }
  }

  for (const [cc, rows] of byCountry) {
    rows.sort((a, b) => packPriority(a.pack, cc) - packPriority(b.pack, cc) || a.pack.localeCompare(b.pack));
  }

  const selected = [];
  const used = new Set();
  const add = (row) => {
    if (!row || used.has(row.file) || selected.length >= limit) return;
    used.add(row.file);
    selected.push(`${EPGSHARE_BASE}${row.file}`);
  };

  // First guarantee a primary guide for USA, UK and Portugal.
  for (const cc of PRIORITY_COUNTRIES) {
    if (counts.has(cc)) add(byCountry.get(cc)?.[0]);
  }

  // Reserve cheap, high-value supplemental packs for priority countries before
  // spending the source budget on the long tail. US_SPORTS1 is small and covers
  // channels that are often absent from the main US pack.
  for (const pack of PRIORITY_SUPPLEMENT_PACKS) {
    const cc = pack.slice(0, 2);
    if (counts.has(cc)) add(byPack.get(pack));
  }

  // Then cover the remaining represented countries, largest first.
  for (const [cc] of countries) add(byCountry.get(cc)?.[0]);

  // Use spare budget on secondary packs, still preferring the priority countries.
  if (selected.length < limit) {
    for (const [cc, count] of countries) {
      if (count < 20 && !PRIORITY_COUNTRIES.includes(cc)) continue;
      for (const row of (byCountry.get(cc) || []).slice(1)) add(row);
      if (selected.length >= limit) break;
    }
  }

  return selected;
}

async function fetchIndex(timeoutMs = 20000) {
  if (indexCache.files.length && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.files;
  const r = await fetch(EPGSHARE_BASE, {
    headers: { "user-agent": "Mozilla/5.0 JustOne EPG", accept: "text/html,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`EPGShare index ${r.status}`);
  const files = parseEpgShareIndex(await r.text());
  if (!files.length) throw new Error("EPGShare index contained no XMLTV packs");
  indexCache = { at: Date.now(), files };
  return files;
}

export async function discoverEpgShareUrls(lineup, maxSources = 12) {
  if (maxSources <= 0) return [];
  const files = await fetchIndex();
  return selectEpgShareUrls(lineup, files, maxSources);
}
