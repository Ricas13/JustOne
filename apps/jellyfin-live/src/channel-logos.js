export function isGeneratedChannelLogo(value) {
  const url = String(value || "").trim();
  return !url || /\/jellyfin\/artwork\/channel\//i.test(url);
}

function normalizeCountry(value) {
  const cc = String(value || "").trim().toUpperCase();
  if (cc === "UK") return "GB";
  if (cc === "USA") return "US";
  return cc;
}

function countrySuffixes(country) {
  switch (normalizeCountry(country)) {
    case "US": return ["usa", "us", "us2", "united states"];
    case "GB": return ["uk", "gb", "united kingdom"];
    case "PT": return ["pt", "portugal"];
    case "CA": return ["ca", "canada"];
    case "ES": return ["es", "spain"];
    case "FR": return ["fr", "france"];
    case "DE": return ["de", "germany"];
    case "IT": return ["it", "italy"];
    default: return [];
  }
}

export function canonicalLogoKey(value, country = "") {
  let s = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[._/+\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const suffix of countrySuffixes(country)) {
    const re = new RegExp(`\\s+${suffix.replace(/\s+/g, "\\s+")}$`, "i");
    if (re.test(s)) s = s.replace(re, "").trim();
  }

  return s
    .replace(/\b(?:uhd|fhd|hd|sd|4k|1080p|720p)\b/g, " ")
    .replace(/\b(?:east feed|west feed|pacific feed|national feed)\b/g, " ")
    .replace(/\b(?:channel|network|television)\b/g, " ")
    .replace(/\btv\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function logoKeys(value, country = "") {
  const canonical = canonicalLogoKey(value, country);
  if (!canonical) return [];
  const compact = canonical.replace(/\s+/g, "");
  return compact && compact !== canonical ? [canonical, compact] : [canonical];
}

function logoScore(row) {
  let score = 0;
  if (/PNG|JPEG|JPG|WEBP/i.test(String(row?.format || ""))) score += 20;
  const tags = (row?.tags || []).join(" ");
  if (/horizontal/i.test(tags)) score += 5;
  if (!/white/i.test(tags)) score += 2;
  score += Math.min(Number(row?.width || 0) / 1000, 3);
  return score;
}

function addAlias(map, key, id) {
  if (!key || !id) return;
  const set = map.get(key) || new Set();
  set.add(id);
  map.set(key, set);
}

export function buildIptvLogoIndex(data = {}) {
  const bestByChannel = new Map();
  for (const row of data.logos || []) {
    const url = String(row?.url || "").trim();
    if (!row?.channel || !/^https?:\/\//i.test(url)) continue;
    const current = bestByChannel.get(row.channel);
    if (!current || logoScore(row) > logoScore(current)) bestByChannel.set(row.channel, row);
  }

  const aliases = new Map();
  const countries = new Map();
  for (const row of data.channels || []) {
    if (!row?.id || !bestByChannel.has(row.id) || row.is_nsfw) continue;
    const country = normalizeCountry(row.country);
    countries.set(row.id, country);
    for (const value of [row.id, row.name, ...(row.alt_names || [])]) {
      for (const key of logoKeys(value, country)) addAlias(aliases, `${country}|${key}`, row.id);
    }
  }

  return { bestByChannel, aliases, countries };
}

function logoForId(index, id) {
  const row = index?.bestByChannel?.get(String(id || ""));
  return /^https?:\/\//i.test(String(row?.url || "")) ? row.url : "";
}

function uniqueAliasLogo(index, country, key) {
  const ids = index?.aliases?.get(`${country}|${key}`);
  if (!ids?.size) return "";
  const urls = [...new Set([...ids].map((id) => logoForId(index, id)).filter(Boolean))];
  return urls.length === 1 ? urls[0] : "";
}

export function findIptvOrgLogo(channel, guideHit, index) {
  if (!index) return "";

  for (const id of [
    channel?.iptvOrgId,
    channel?.tvgId,
    ...(channel?.sourceTvgIds || []),
    guideHit?.id,
  ]) {
    const direct = logoForId(index, id);
    if (direct) return direct;
  }

  const country = normalizeCountry(channel?.country);
  if (!country) return "";
  const values = [
    guideHit?.id,
    ...(guideHit?.meta?.display || []),
    channel?.name,
    channel?.tvgId,
    channel?.iptvOrgId,
    ...(channel?.sourceTvgIds || []),
    ...(channel?.candidates || []).map((candidate) => candidate?.label),
  ];

  for (const value of values.filter(Boolean)) {
    for (const key of logoKeys(value, country)) {
      const logo = uniqueAliasLogo(index, country, key);
      if (logo) return logo;
    }
  }
  return "";
}

export function chooseChannelLogo(currentLogo, guideLogo, iptvOrgLogo = "") {
  const current = String(currentLogo || "").trim();
  const guide = String(guideLogo || "").trim();
  const iptv = String(iptvOrgLogo || "").trim();
  if (!isGeneratedChannelLogo(current)) return { logo: current, source: "existing", changed: false };
  if (/^https?:\/\//i.test(guide) && !isGeneratedChannelLogo(guide)) {
    return { logo: guide, source: "epg", changed: true };
  }
  if (/^https?:\/\//i.test(iptv) && !isGeneratedChannelLogo(iptv)) {
    return { logo: iptv, source: "iptv-org", changed: true };
  }
  return { logo: current, source: "generated", changed: false };
}
