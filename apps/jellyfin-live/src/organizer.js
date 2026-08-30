import crypto from "node:crypto";
import zlib from "node:zlib";
import { config, withKey } from "./config.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const COUNTRY_CODES = new Map([
  ["uk", "GB"], ["united kingdom", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"],
  ["usa", "US"], ["us", "US"], ["united states", "US"], ["portugal", "PT"], ["spain", "ES"],
  ["france", "FR"], ["germany", "DE"], ["italy", "IT"], ["canada", "CA"], ["ireland", "IE"],
  ["netherlands", "NL"], ["australia", "AU"], ["brazil", "BR"], ["poland", "PL"], ["romania", "RO"],
  ["greece", "GR"], ["turkey", "TR"], ["sweden", "SE"], ["norway", "NO"], ["denmark", "DK"],
  ["finland", "FI"], ["austria", "AT"], ["switzerland", "CH"], ["belgium", "BE"], ["czechia", "CZ"],
  ["slovakia", "SK"], ["serbia", "RS"], ["croatia", "HR"], ["slovenia", "SI"], ["ukraine", "UA"],
  ["russia", "RU"], ["israel", "IL"], ["india", "IN"], ["pakistan", "PK"], ["malaysia", "MY"],
  ["japan", "JP"], ["korea", "KR"], ["china", "CN"], ["mexico", "MX"], ["argentina", "AR"],
]);

const COUNTRY_BASE = new Map([
  ["GB", 2000], ["PT", 2200], ["US", 2400], ["CA", 2700], ["ES", 2800], ["FR", 3000],
  ["DE", 3200], ["IT", 3400], ["NL", 3600], ["IE", 3700], ["AU", 3800], ["BR", 3900],
]);

const SPORT_SPECS = [
  { key: "football", label: "Football", emoji: "⚽", base: 100, minutes: 150, re: /football|soccer|premier league|championship|league one|league two|liga|bundesliga|serie a|uefa|fifa|mls|nwsl|fa cup|carabao|copa/i },
  { key: "tennis", label: "Tennis", emoji: "🎾", base: 200, minutes: 240, re: /tennis|atp|wta|us open|wimbledon|roland garros|australian open/i },
  { key: "basketball", label: "Basketball", emoji: "🏀", base: 250, minutes: 150, re: /basketball|nba|wnba|euroleague|fiba/i },
  { key: "motorsport", label: "Motorsport", emoji: "🏎", base: 300, minutes: 240, re: /motorsport|formula 1|formula one|\bf1\b|nascar|indycar|motogp|superbike|speedway|racing|grand prix/i },
  { key: "combat", label: "Combat", emoji: "🥊", base: 350, minutes: 300, re: /boxing|mma|ufc|wrestling|aew|wwe|combat|fight|bellator|one championship/i },
  { key: "american-football", label: "American Football", emoji: "🏈", base: 400, minutes: 240, re: /american football|nfl|ncaa football|cfl|college football/i },
  { key: "baseball", label: "Baseball", emoji: "⚾", base: 450, minutes: 240, re: /baseball|mlb|little league/i },
  { key: "hockey", label: "Hockey", emoji: "🏒", base: 500, minutes: 180, re: /ice hockey|nhl|hockey/i },
  { key: "golf", label: "Golf", emoji: "⛳", base: 550, minutes: 360, re: /golf|pga|lpga|ryder cup|solheim/i },
  { key: "cricket", label: "Cricket", emoji: "🏏", base: 600, minutes: 480, re: /cricket|ipl|t20|test match/i },
  { key: "rugby", label: "Rugby", emoji: "🏉", base: 650, minutes: 180, re: /rugby|six nations/i },
];

function txt(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function hash(v, n = 12) {
  return crypto.createHash("sha1").update(String(v)).digest("hex").slice(0, n);
}

function normalize(v) {
  return txt(v)
    .toLowerCase()
    .replace(/\b(uhd|fhd|hd|4k|1080p|720p)\b/g, "")
    .replace(/[()\[\]]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDecode(v) {
  return String(v || "")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function decodeHtml(v) {
  return xmlDecode(String(v || ""))
    .replace(/&nbsp;/gi, " ")
    .replace(/&#039;/g, "'")
    .trim();
}

function stripXml(v) {
  return txt(xmlDecode(String(v || "").replace(/<[^>]+>/g, " ")));
}

function attr(line, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(line);
  return m ? decodeHtml(m[1]) : "";
}

export function parseM3u(body) {
  const lines = String(body || "").split(/\r?\n/);
  const out = [];
  let meta = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      meta = {
        name: txt(line.split(",").slice(1).join(",")),
        tvgId: attr(line, "tvg-id"),
        tvgName: attr(line, "tvg-name"),
        logo: attr(line, "tvg-logo"),
        number: Number(attr(line, "tvg-chno") || 0),
        group: attr(line, "group-title") || "Live",
      };
      continue;
    }
    if (meta && /^https?:\/\//i.test(line.trim())) {
      out.push({ ...meta, url: line.trim() });
      meta = null;
    }
  }
  return out;
}

export function isAdultChannel(ch) {
  return /(^|\b)(18\+|adult|xxx|porn|playboy|brazzers|redlight)(\b|$)/i.test(`${ch?.name || ""} ${ch?.group || ""}`);
}

function sourceLabel(ch) {
  const p = txt(ch.name).split(/\s+[—–]\s+/);
  return p.length > 1 ? p.slice(1).join(" — ") : ch.name;
}

function eventTitle(ch) {
  return txt(ch.name).split(/\s+[—–]\s+/)[0];
}

function isEvent(ch) {
  return /\s+[—–]\s+/.test(ch.name || "") && !/^24\s*\/\s*7/i.test(ch.group || "");
}

function sportSpec(group, title) {
  const hay = `${group || ""} ${title || ""}`;
  return SPORT_SPECS.find((s) => s.re.test(hay)) || { key: "other", label: "Other Sports", emoji: "📺", base: 700, minutes: 180 };
}

function sourceScore(ch) {
  const s = sourceLabel(ch).toLowerCase();
  let n = ch.logo ? 2 : 0;
  if (/backup/.test(s)) n -= 30;
  if (/sd stream|event sd/.test(s)) n -= 15;
  if (/event stream|event ppv|ppv feed/.test(s)) n -= 8;
  if (/sky|espn|tnt|bein|dazn|eurosport|bbc|itv|sport tv|canal\+|fox|nbc|cbs/.test(s)) n += 8;
  return n;
}

function dedupeCandidates(rows) {
  const seen = new Set();
  return [...rows]
    .sort((a, b) => sourceScore(b) - sourceScore(a))
    .filter((x) => {
      if (!x.url || seen.has(x.url)) return false;
      seen.add(x.url);
      return true;
    })
    .map((x) => ({ url: x.url, label: sourceLabel(x) }));
}

function countryCode(ch) {
  const hay = `${ch.group || ""} ${ch.name || ""}`.toLowerCase();
  for (const [name, code] of COUNTRY_CODES) {
    if (new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(hay)) return code;
  }
  const suffix = /\.([a-z]{2})$/i.exec(ch.tvgId || "")?.[1]?.toUpperCase();
  return suffix || "";
}

function londonOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(new Date(utcMs));
  const zone = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/i.exec(zone);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === "-" ? -mins : mins;
}

function londonDateMs(year, month, day, hour, minute) {
  const base = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = base;
  for (let i = 0; i < 2; i++) guess = base - londonOffsetMinutes(guess) * 60 * 1000;
  return guess;
}

const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3], ["apr", 4], ["april", 4],
  ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9],
  ["september", 9], ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);

export function parseScheduleMetadata(html) {
  const plain = decodeHtml(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const dm = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(20\d{2})\s*-?\s*Schedule Time UK/i.exec(plain)
    || /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(20\d{2})/i.exec(plain);
  const day = Number(dm?.[1] || new Date().getUTCDate());
  const month = MONTHS.get(String(dm?.[2] || "").toLowerCase()) || new Date().getUTCMonth() + 1;
  const year = Number(dm?.[3] || new Date().getUTCFullYear());
  const byEvent = new Map();
  let group = "Sports";
  const tokenRe = /card__meta">([^<]+)<|schedule__eventTitle">([^<]+)</gi;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[1]) {
      group = txt(decodeHtml(m[1])).slice(0, 100) || "Sports";
      continue;
    }
    const title = txt(decodeHtml(m[2]));
    if (!title) continue;
    const before = html.slice(Math.max(0, m.index - 700), m.index);
    const times = [...before.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
    const last = times[times.length - 1];
    if (!last) continue;
    const start = londonDateMs(year, month, day, Number(last[1]), Number(last[2]));
    const key = normalize(title);
    const row = { title, group, start, upcoming: /upcoming/i.test(group) };
    if (key && !byEvent.has(key)) byEvent.set(key, row);
  }
  return { year, month, day, byEvent };
}

function generatedArtwork(token, variant = "program") {
  return withKey(`${config.publicUrl}/jellyfin/artwork/${variant}/${encodeURIComponent(token)}.png`);
}

function iptvNameIndex(channels) {
  const map = new Map();
  for (const ch of channels || []) {
    for (const name of [ch.name, ...(ch.alt_names || [])]) {
      const key = normalize(name);
      if (!key) continue;
      const arr = map.get(key) || [];
      arr.push(ch);
      map.set(key, arr);
    }
  }
  return map;
}

function bestIptvMatch(ch, nameIndex) {
  const variants = [ch.tvgName, ch.name]
    .filter(Boolean)
    .flatMap((n) => [n, n.replace(/\b(uk|usa|us|portugal|france|spain|germany|italy|canada)\b/gi, " ")])
    .map(normalize)
    .filter(Boolean);
  const country = countryCode(ch);
  for (const key of variants) {
    const rows = nameIndex.get(key) || [];
    if (!rows.length) continue;
    if (country) {
      const exact = rows.find((r) => String(r.country || "").toUpperCase() === country);
      if (exact) return exact;
    }
    if (rows.length === 1) return rows[0];
  }
  return null;
}

function chooseLogo(logos, channelId) {
  const rows = (logos || []).filter((x) => x.channel === channelId && x.in_use !== false);
  const score = (x) => {
    let s = 0;
    if (/PNG|JPEG|JPG|WEBP/i.test(x.format || "")) s += 20;
    if (/horizontal/i.test((x.tags || []).join(" "))) s += 5;
    if (!/white/i.test((x.tags || []).join(" "))) s += 2;
    s += Math.min(Number(x.width || 0) / 1000, 3);
    return s;
  };
  return rows.sort((a, b) => score(b) - score(a))[0]?.url || "";
}

export function enrichStaticWithIptvOrg(rows, data = {}) {
  const nameIndex = iptvNameIndex(data.channels || []);
  return rows.map((ch) => {
    const match = bestIptvMatch(ch, nameIndex);
    if (!match || match.is_nsfw) return ch;
    return {
      ...ch,
      iptvOrgId: match.id,
      tvgId: match.id || ch.tvgId,
      logo: ch.logo || chooseLogo(data.logos || [], match.id),
      country: String(match.country || countryCode(ch) || "").toUpperCase(),
    };
  });
}

function buildSportSlots(events, schedule) {
  const grouped = new Map();
  for (const ch of events) {
    const title = eventTitle(ch);
    const sched = schedule?.byEvent?.get(normalize(title));
    if (sched?.upcoming) continue;
    const spec = sportSpec(ch.group || sched?.group, title);
    const start = sched?.start || Date.now() - 15 * 60 * 1000;
    const dayKey = new Date(start).toISOString().slice(0, 10);
    const key = `${dayKey}|${normalize(title)}`;
    const row = grouped.get(key) || {
      key, title, group: sched?.group || ch.group || spec.label, spec, start,
      end: start + spec.minutes * 60 * 1000, rows: [],
    };
    row.rows.push(ch);
    grouped.set(key, row);
  }

  const bySport = new Map();
  for (const evt of grouped.values()) {
    evt.candidates = dedupeCandidates(evt.rows);
    if (!evt.candidates.length) continue;
    const arr = bySport.get(evt.spec.key) || [];
    arr.push(evt);
    bySport.set(evt.spec.key, arr);
  }

  const out = [];
  for (const [key, eventsForSport] of bySport) {
    eventsForSport.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    const spec = eventsForSport[0].spec;
    const slots = [];
    for (const evt of eventsForSport) {
      let slot = slots.find((s) => s.lastEnd <= evt.start);
      if (!slot) {
        slot = { index: slots.length + 1, lastEnd: 0, programmes: [] };
        slots.push(slot);
      }
      slot.programmes.push(evt);
      slot.lastEnd = evt.end;
    }
    for (const slot of slots) {
      const idx = String(slot.index).padStart(2, "0");
      const id = `sport.${key}.${idx}`;
      out.push({
        id,
        tvgId: `justone.${id}`,
        name: `${spec.emoji} ${spec.label} ${idx}`,
        group: `Sports | ${spec.label}`,
        number: spec.base + slot.index - 1,
        logo: generatedArtwork(`sport-${key}`, "channel"),
        kind: "sport-slot",
        programmes: slot.programmes.map((evt) => ({
          start: evt.start,
          end: evt.end,
          title: evt.title,
          subtitle: evt.group,
          description: `Available sources: ${evt.candidates.map((x) => x.label).join(", ")}`,
          categories: ["Sports", spec.label],
          icon: generatedArtwork(`${key}-${hash(evt.title)}`, "program"),
          candidates: evt.candidates,
        })),
      });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

function staticBucketBase(group, country) {
  if (group === "24/7") return 1000;
  return COUNTRY_BASE.get(country) || 4000;
}

function displayGroup(ch) {
  if (/24\s*\/\s*7/i.test(ch.group || "") || /24\s*\/\s*7/i.test(ch.name || "")) return "24/7";
  const cc = ch.country || countryCode(ch);
  if (cc) return `TV | ${cc}`;
  return "TV | International";
}

function buildStaticChannels(rows) {
  const grouped = new Map();
  for (const ch of rows) {
    const country = ch.country || countryCode(ch) || "";
    const key = `${country}|${normalize(ch.tvgName || ch.name)}`;
    const arr = grouped.get(key) || [];
    arr.push(ch);
    grouped.set(key, arr);
  }
  const buckets = new Map();
  for (const [key, items] of grouped) {
    const preferred = [...items].sort((a, b) => sourceScore(b) - sourceScore(a))[0];
    const group = displayGroup(preferred);
    const country = preferred.country || countryCode(preferred) || "";
    const bkey = `${group}|${country}`;
    const bucket = buckets.get(bkey) || [];
    bucket.push({ key, items, preferred, group, country });
    buckets.set(bkey, bucket);
  }

  const out = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.preferred.name.localeCompare(b.preferred.name));
    bucket.forEach((entry, i) => {
      const { preferred, items, group, country } = entry;
      const id = `channel.${hash(entry.key, 14)}`;
      out.push({
        id,
        tvgId: preferred.iptvOrgId || preferred.tvgId || `justone.${id}`,
        sourceTvgIds: [...new Set(items.map((x) => x.tvgId).filter(Boolean))],
        iptvOrgId: preferred.iptvOrgId || "",
        name: preferred.tvgName || preferred.name,
        group,
        country,
        number: staticBucketBase(group, country) + i,
        logo: preferred.logo || generatedArtwork(`${country}-${preferred.name}`, "channel"),
        kind: "static",
        candidates: dedupeCandidates(items),
        programmes: [],
      });
    });
  }

  const seenIds = new Set();
  for (const ch of out.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name))) {
    if (!seenIds.has(ch.tvgId)) {
      seenIds.add(ch.tvgId);
    } else {
      ch.tvgId = `${ch.tvgId}.justone.${hash(ch.id, 6)}`;
      seenIds.add(ch.tvgId);
    }
  }
  return out;
}

export function buildLineup(rawRows, { schedule = null, iptvOrg = null } = {}) {
  const rows = (rawRows || []).filter((x) => !config.excludeAdult || !isAdultChannel(x));
  const eventRows = rows.filter(isEvent);
  let staticRows = rows.filter((x) => !isEvent(x));
  if (iptvOrg) staticRows = enrichStaticWithIptvOrg(staticRows, iptvOrg);
  return [...buildSportSlots(eventRows, schedule), ...buildStaticChannels(staticRows)];
}

export function getCurrentCandidates(channel, now = Date.now()) {
  if (!channel) return [];
  if (channel.kind === "static") return channel.candidates || [];
  const current = (channel.programmes || []).find((p) => now >= p.start - 30 * 60 * 1000 && now <= p.end + 30 * 60 * 1000)
    || (channel.programmes || []).filter((p) => p.start > now).sort((a, b) => a.start - b.start)[0];
  return current?.candidates || [];
}

export function buildM3u(lineup) {
  const guide = withKey(`${config.publicUrl}/jellyfin/guide.xml`);
  const lines = [`#EXTM3U url-tvg="${guide}" x-tvg-url="${guide}" tvg-shift=0`];
  for (const ch of lineup) {
    const name = txt(ch.name).replace(/["\r\n]/g, " ");
    const group = txt(ch.group).replace(/["\r\n]/g, " ");
    lines.push(`#EXTINF:-1 tvg-id="${ch.tvgId}" tvg-name="${name}" tvg-logo="${ch.logo}" tvg-chno="${ch.number}" group-title="${group}",${name}`);
    lines.push(withKey(`${config.publicUrl}/jellyfin/play/${encodeURIComponent(ch.id)}.ts`));
  }
  return lines.join("\n") + "\n";
}

export function parseXmlTv(body) {
  const channels = new Map();
  const names = new Map();
  const programmes = new Map();
  let m;
  const channelRe = /<channel\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  while ((m = channelRe.exec(body))) {
    const id = xmlDecode(m[1]);
    const inner = m[2];
    const display = [...inner.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)].map((x) => stripXml(x[1])).filter(Boolean);
    const icon = xmlDecode(/<icon\b[^>]*\bsrc="([^"]+)"/i.exec(inner)?.[1] || "");
    channels.set(id, { id, display, icon });
    for (const n of display) {
      const key = normalize(n);
      if (key && !names.has(key)) names.set(key, id);
    }
  }
  const programRe = /<programme\b[\s\S]*?<\/programme>/gi;
  while ((m = programRe.exec(body))) {
    const full = m[0];
    const id = xmlDecode(/\bchannel="([^"]+)"/i.exec(full)?.[1] || "");
    if (!id) continue;
    const arr = programmes.get(id) || [];
    arr.push(full);
    programmes.set(id, arr);
  }
  return { channels, names, programmes };
}

function externalForChannel(ch, docs) {
  for (const doc of docs || []) {
    for (const id of [ch.tvgId, ch.iptvOrgId, ...(ch.sourceTvgIds || [])]) {
      if (id && doc.channels.has(id)) return { doc, id, meta: doc.channels.get(id) };
    }
  }
  const variants = [ch.name, ch.name.replace(/\b(UK|USA|US|Portugal|France|Spain|Germany|Italy|Canada)\b/gi, " ")].map(normalize).filter(Boolean);
  for (const doc of docs || []) {
    for (const n of variants) {
      const id = doc.names.get(n);
      if (id) return { doc, id, meta: doc.channels.get(id) };
    }
  }
  return null;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

function generatedProgramXml(ch, p) {
  const cats = (p.categories || []).map((c) => `    <category>${xml(c)}</category>`).join("\n");
  return [
    `  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="${xml(ch.tvgId)}">`,
    `    <title>${xml(p.title)}</title>`,
    p.subtitle ? `    <sub-title>${xml(p.subtitle)}</sub-title>` : "",
    p.description ? `    <desc>${xml(p.description)}</desc>` : "",
    cats,
    p.icon ? `    <icon src="${xml(p.icon)}" />` : "",
    p.icon ? `    <image type="backdrop" size="3" orient="L">${xml(p.icon)}</image>` : "",
    "  </programme>",
  ].filter(Boolean).join("\n");
}

function placeholderPrograms(ch) {
  const start = Math.floor((Date.now() - 6 * HOUR) / (6 * HOUR)) * 6 * HOUR;
  const icon = ch.logo || generatedArtwork(ch.id, "program");
  const out = [];
  for (let t = start; t < start + 3 * DAY; t += 6 * HOUR) {
    out.push({ start: t, end: t + 6 * HOUR, title: ch.name, subtitle: "Live channel", categories: ["Live TV"], icon,
      description: "Detailed programme data is not available from the configured guide sources." });
  }
  return out;
}

function adaptExternalProgram(full, ch, fallbackIcon) {
  let out = full.replace(/\bchannel="[^"]+"/i, `channel="${xml(ch.tvgId)}"`);
  if (!/<icon\b/i.test(out)) out = out.replace(/<\/programme>/i, `  <icon src="${xml(fallbackIcon)}" />\n</programme>`);
  return out;
}

export function buildXmlTv(lineup, docs = []) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="JustOne Jellyfin Live" generator-info-url="https://github.com/Ricas13/JustOne">',
  ];
  const hits = new Map();
  for (const ch of lineup) {
    const hit = ch.kind === "static" ? externalForChannel(ch, docs) : null;
    if (hit) hits.set(ch.id, hit);
    const icon = ch.logo || hit?.meta?.icon || generatedArtwork(ch.id, "channel");
    lines.push(`  <channel id="${xml(ch.tvgId)}">`);
    lines.push(`    <display-name>${xml(ch.name)}</display-name>`);
    lines.push(`    <icon src="${xml(icon)}" />`);
    lines.push("  </channel>");
  }
  for (const ch of lineup) {
    if (ch.kind === "sport-slot") {
      for (const p of ch.programmes || []) lines.push(generatedProgramXml(ch, p));
      continue;
    }
    const hit = hits.get(ch.id);
    const external = hit?.doc?.programmes?.get(hit.id) || [];
    if (external.length) {
      const fallback = ch.logo || hit.meta?.icon || generatedArtwork(ch.id, "program");
      for (const p of external) lines.push(adaptExternalProgram(p, ch, fallback));
    } else {
      for (const p of placeholderPrograms(ch)) lines.push(generatedProgramXml(ch, p));
    }
  }
  lines.push("</tv>");
  return lines.join("\n") + "\n";
}

export function guideSourceUrlsForLineup(lineup, guideRows = [], maxSources = config.epgMaxSources) {
  const wanted = new Set(lineup.map((c) => c.iptvOrgId).filter(Boolean));
  const counts = new Map();
  for (const row of guideRows || []) {
    if (!wanted.has(row.channel)) continue;
    for (const src of row.sources || []) {
      if (src.format && !/xml/i.test(src.format)) continue;
      if (!/^https?:\/\//i.test(src.url || "")) continue;
      const cur = counts.get(src.url) || { url: src.url, count: 0 };
      cur.count += 1;
      counts.set(src.url, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, Math.max(0, maxSources)).map((x) => x.url);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

export function artworkPng(token, variant = "program") {
  const width = variant === "channel" ? 512 : 1200;
  const height = variant === "channel" ? 512 : 675;
  const seed = crypto.createHash("sha256").update(String(token)).digest();
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const mix = ((x / width) * 70 + (y / height) * 50) | 0;
      const stripe = ((x + y) % Math.max(24, Math.floor(width / 12))) < 4 ? 28 : 0;
      raw[o++] = (seed[0] + mix + stripe) & 255;
      raw[o++] = (seed[7] + Math.floor(mix * 0.7) + stripe) & 255;
      raw[o++] = (seed[15] + Math.floor(mix * 0.4) + stripe) & 255;
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
