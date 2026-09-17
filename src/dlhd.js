import { countryGroup, countryOf, isCountryWord, strippedChannelName } from "./identity.js";
import { hash, normalize, slug, stripTags, text } from "./util.js";


const NUMBER_WORDS = new Map([
  ["one","1"],["two","2"],["three","3"],["four","4"],["five","5"],
  ["six","6"],["seven","7"],["eight","8"],["nine","9"],["ten","10"],
]);
const GENERIC_EVENT_ALIAS_RE = /^(?:event(?:\s+(?:sd|hd|fhd))?\s+(?:stream|feed)|event\s+ppv|channel\s+not\s+listed|bb\s+cam\s+live|multifeed)$/i;
const GENERIC_CHANNEL_LINK_RE = /^(?:watch|watch now|play|play now|live|live now|open|open channel)$/i;

function htmlText(value) {
  return stripTags(String(value || "").replace(/&nbsp;/gi, " ").replace(/&#039;/g, "'"));
}
function logoUrl(baseUrl, value) {
  const raw = text(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  try { return new URL(raw, `${String(baseUrl).replace(/\/+$/, "")}/`).toString(); } catch { return raw; }
}
function channelIdFromHref(href) {
  return /(?:watch\.php\?(?:[^"']*&)?id=|stream-)(\d+)/i.exec(String(href || ""))?.[1] || "";
}
function cardTitle(value) {
  return htmlText(/card__title[^>]*>([\s\S]*?)<\//i.exec(String(value || ""))?.[1] || "");
}
function nearestCardTitle(source, start, end, anchorCenter) {
  const segment = source.slice(start, end);
  const re = /card__title[^>]*>([\s\S]*?)<\//gi;
  const candidates = [];
  let match;
  while ((match = re.exec(segment))) {
    const name = htmlText(match[1]);
    if (!name) continue;
    const absolute = start + match.index;
    candidates.push({ name, distance: Math.abs(absolute - anchorCenter) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.name || "";
}
function nearestImage(source, start, end, anchorCenter) {
  const segment = source.slice(start, end);
  const re = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/gi;
  const candidates = [];
  let match;
  while ((match = re.exec(segment))) {
    const absolute = start + match.index;
    candidates.push({ value: match[1], distance: Math.abs(absolute - anchorCenter) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.value || "";
}
export function parse247Html(html, baseUrl = "https://dlive.sx") {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const anchors = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(source))) {
    const id = channelIdFromHref(match[1]);
    if (!id) continue;
    anchors.push({ id, href: match[1], body: match[2], index: match.index, end: anchorRe.lastIndex });
  }

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (seen.has(anchor.id)) continue;

    // DLHD has moved card__title both inside, before and after the clickable
    // channel link over time. Search the local neighbourhood bounded by the
    // midpoints to the previous/next channel links rather than blindly looking
    // forward, which can accidentally assign the next card's title to this ID.
    const previous = anchors[i - 1];
    const next = anchors[i + 1];
    const start = previous
      ? Math.max(0, Math.floor((previous.end + anchor.index) / 2))
      : Math.max(0, anchor.index - 1200);
    const end = next
      ? Math.min(source.length, Math.ceil((anchor.end + next.index) / 2))
      : Math.min(source.length, anchor.end + 1200);
    const center = Math.floor((anchor.index + anchor.end) / 2);

    let name = cardTitle(anchor.body) || nearestCardTitle(source, start, end, center);
    const linkText = htmlText(anchor.body);
    if (!name && linkText && !GENERIC_CHANNEL_LINK_RE.test(linkText)) name = linkText;
    if (!name) continue;

    seen.add(anchor.id);
    const embeddedLogo = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i.exec(anchor.body)?.[1] || "";
    const logo = embeddedLogo || nearestImage(source, start, end, center);
    out.push({ id: anchor.id, name, logo: logoUrl(baseUrl, logo) });
  }

  const legacyRe = /href=["'][^"']*watch\.php\?id=(\d+)[^"']*["'][^>]*>[\s\S]{0,600}?card__title[^>]*>([\s\S]*?)<\//gi;
  while ((match = legacyRe.exec(source))) {
    const id = match[1];
    if (seen.has(id)) continue;
    const name = htmlText(match[2]);
    if (!name) continue;
    seen.add(id);
    out.push({ id, name, logo: "" });
  }
  return out;
}

const MONTHS = new Map([
  ["jan",1],["january",1],["feb",2],["february",2],["mar",3],["march",3],["apr",4],["april",4],["may",5],
  ["jun",6],["june",6],["jul",7],["july",7],["aug",8],["august",8],["sep",9],["sept",9],["september",9],
  ["oct",10],["october",10],["nov",11],["november",11],["dec",12],["december",12],
]);
function scheduleDate(value) {
  const plain = htmlText(value);
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(20\d{2})\s*-?\s*Schedule Time UK/i.exec(plain);
  if (!m) return null;
  const month = MONTHS.get(m[2].toLowerCase());
  return month ? { year:Number(m[3]), month, day:Number(m[1]), label:m[0] } : null;
}
function londonOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/London", timeZoneName:"shortOffset", hour:"2-digit" }).formatToParts(new Date(utcMs));
  const zone = parts.find((p)=>p.type==="timeZoneName")?.value || "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/i.exec(zone);
  if (!m) return 0;
  const mins = Number(m[2])*60 + Number(m[3]||0);
  return m[1] === "-" ? -mins : mins;
}
function londonDateMs(year, month, day, hour, minute) {
  const base = Date.UTC(year, month-1, day, hour, minute, 0);
  let guess = base;
  for (let i=0;i<2;i++) guess = base - londonOffsetMinutes(guess)*60_000;
  return guess;
}
function eventDurationMinutes(category, title) {
  const hay = normalize(`${category} ${title}`);
  if (/\b(?:cricket|test match)\b/.test(hay)) return 480;
  if (/\b(?:golf)\b/.test(hay)) return 360;
  if (/\b(?:tennis)\b/.test(hay)) return 240;
  if (/\b(?:motorsport|formula 1|f1|nascar|motogp)\b/.test(hay)) return 240;
  return 180;
}
function lastMatch(re, value) {
  let last = null, m;
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = copy.exec(value))) last = m;
  return last;
}
export function parseScheduleHtml(html, baseUrl = "https://dlive.sx") {
  const source = String(html || "");
  const date = scheduleDate(source);
  const titleRe = /<[^>]*class=["'][^"']*schedule__eventTitle[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|h\d)>/gi;
  const titles = [];
  let m;
  while ((m = titleRe.exec(source))) titles.push({ index:m.index, end:titleRe.lastIndex, title:htmlText(m[1]) });
  const events = [];
  for (let i=0;i<titles.length;i++) {
    const row = titles[i];
    if (!row.title) continue;
    const before = source.slice(Math.max(0, row.index-5000), row.index);
    const cat = lastMatch(/class=["'][^"']*card__meta[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|h\d)>/gi, before);
    const category = htmlText(cat?.[1] || "Events") || "Events";
    const timeMatches = [...before.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
    const tm = timeMatches[timeMatches.length-1];
    const after = source.slice(row.end, i+1<titles.length ? titles[i+1].index : Math.min(source.length, row.end+8000));
    const channels = [];
    const seen = new Set();
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = anchorRe.exec(after))) {
      const id = channelIdFromHref(a[1]);
      if (!id || seen.has(id)) continue;
      const name = htmlText(a[2]);
      if (!name) continue;
      seen.add(id);
      const logo = /<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i.exec(a[2])?.[1] || "";
      channels.push({ id, name, logo:logoUrl(baseUrl, logo) });
    }
    let start = null;
    if (date && tm) start = londonDateMs(date.year, date.month, date.day, Number(tm[1]), Number(tm[2]));
    const minutes = eventDurationMinutes(category, row.title);
    events.push({
      id: `event-${hash(`${date?.year||""}-${date?.month||""}-${date?.day||""}|${tm?.[0]||""}|${row.title}`, 12)}`,
      title: row.title,
      category,
      time: tm?.[0] || "",
      start,
      end: start == null ? null : start + minutes*60_000,
      upcoming: /upcoming/i.test(category),
      channels,
    });
  }
  return { date, events };
}

export function parseProtectedChannels(payload, baseUrl = "https://dlive.sx") {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((row)=>({
    id:text(row.channel_id ?? row.id),
    name:text(row.channel_name ?? row.name),
    logo:logoUrl(baseUrl, row.logo_url ?? row.logo),
  })).filter((row)=>row.id && row.name);
}
function parseDayHeader(header) {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(20\d{2})/i.exec(String(header||""));
  const month = m ? MONTHS.get(m[2].toLowerCase()) : null;
  return m && month ? { year:Number(m[3]), month, day:Number(m[1]), label:String(header) } : null;
}
export function parseProtectedSchedule(payload, baseUrl = "https://dlive.sx") {
  const root = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
  const events = [];
  if (!root || typeof root !== "object" || Array.isArray(root)) return { events };
  for (const [dayHeader, categories] of Object.entries(root)) {
    const date = parseDayHeader(dayHeader);
    if (!categories || typeof categories !== "object") continue;
    for (const [category, rows] of Object.entries(categories)) {
      for (const row of Array.isArray(rows) ? rows : []) {
        const title = text(row.event ?? row.title);
        if (!title) continue;
        const time = text(row.time);
        const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
        const start = date && tm ? londonDateMs(date.year,date.month,date.day,Number(tm[1]),Number(tm[2])) : null;
        const allChannels = [...(Array.isArray(row.channels)?row.channels:[]), ...(Array.isArray(row.channels2)?row.channels2:[])];
        const channels = allChannels.map((ch)=>({
          id:text(ch.channel_id ?? ch.id), name:text(ch.channel_name ?? ch.name), logo:logoUrl(baseUrl, ch.logo_url ?? ch.logo),
        })).filter((ch)=>ch.id && ch.name);
        events.push({
          id:`event-${hash(`${dayHeader}|${time}|${title}`,12)}`,
          title, category:text(category)||"Events", time, start,
          end:start == null ? null : start + eventDurationMinutes(category,title)*60_000,
          upcoming:/upcoming/i.test(category), channels,
        });
      }
    }
  }
  return { events };
}

function referenceIdentity(kind, name, seed) {
  const clean = text(name);
  const key = normalize(`${kind}|${seed || clean}`);
  const short = slug(clean).slice(0,48);
  const suffix = hash(key,8);
  return { key, id:`${kind}-${short}-${suffix}`, tvgId:`justone.${kind}.${short}.${suffix}` };
}
export function buildDlhdReference({ channels = [], schedule = { events:[] }, mode = "html" } = {}) {
  const staticRows = channels.map((ch)=>{
    const name = text(ch.name);
    const country = countryOf({ name });
    return {
      kind:"channel", dlhdId:text(ch.id), name, logo:text(ch.logo), aliases:[name], country, group:countryGroup(country),
      ...referenceIdentity("channel", name, ch.id || name),
    };
  }).filter((row)=>row.name);

  const staticById = new Map(staticRows.filter((row)=>row.dlhdId).map((row)=>[String(row.dlhdId), row]));
  const staticByName = new Map();
  for (const row of staticRows) {
    for (const value of [row.name, ...(row.aliases || [])]) {
      const key = normalize(value);
      if (key && !staticByName.has(key)) staticByName.set(key, row);
    }
  }

  const standaloneEvents = [];
  const linearEvents = [];
  for (const evt of schedule.events || []) {
    const title = text(evt.title);
    if (!title) continue;
    const linkedChannels = evt.channels || [];
    const linkedStaticChannels = [];
    const seenStatic = new Set();
    for (const linked of linkedChannels) {
      const hit = staticById.get(String(linked.id || "")) || staticByName.get(normalize(linked.name || ""));
      if (!hit || seenStatic.has(hit.id)) continue;
      seenStatic.add(hit.id);
      linkedStaticChannels.push({
        id: hit.id,
        dlhdId: hit.dlhdId,
        tvgId: hit.tvgId,
        name: hit.name,
        country: hit.country,
        group: hit.group,
      });
    }

    const specificAliases = linkedChannels
      .map((ch)=>text(ch.name))
      .filter((name)=>name && !GENERIC_EVENT_ALIAS_RE.test(normalize(name)));
    const identity = referenceIdentity("event", title, `${evt.id}|${evt.start||evt.time||""}`);
    const row = {
      kind:"event",
      dlhdId:text(evt.id),
      name:title,
      logo:text(linkedChannels.find((ch)=>ch.logo)?.logo || ""),
      group:`Events | ${text(evt.category || "Other")}`,
      aliases:[title, ...specificAliases],
      linkedChannels,
      linkedStaticChannels,
      start:evt.start,
      end:evt.end,
      time:evt.time,
      category:text(evt.category),
      upcoming:evt.upcoming===true,
      ...identity,
    };

    // A scheduled event carried by a normal DLHD 24/7 channel belongs in that
    // channel's EPG, not as a duplicate temporary Live TV channel. Standalone
    // schedule entries (PPV/Event Stream/etc.) remain event references and must
    // match a provider event stream of their own.
    if (linkedStaticChannels.length) linearEvents.push(row);
    else standaloneEvents.push(row);
  }

  return {
    generatedAt:new Date().toISOString(),
    mode,
    channels:staticRows,
    events:standaloneEvents,
    linearEvents,
  };
}

function canonicalToken(token) {
  if (NUMBER_WORDS.has(token)) return NUMBER_WORDS.get(token);
  if (token === "events") return "event";
  if (token === "channels") return "channel";
  return token;
}
function keyVariants(value) {
  let base = normalize(strippedChannelName(value));
  if (!base) return [];
  let tokens = base.split(" ").filter(Boolean);
  while (tokens.length > 1 && isCountryWord(tokens[0])) tokens.shift();
  while (tokens.length > 1 && isCountryWord(tokens[tokens.length-1])) tokens.pop();
  tokens = tokens.map(canonicalToken);
  base = tokens.join(" ");
  const out = new Set([base, base.replace(/\s+/g,"")]);
  const withoutRegion = tokens.filter((token)=>!new Set(["east","west"]).has(token));
  if (withoutRegion.length !== tokens.length) {
    const regional = withoutRegion.join(" ");
    out.add(regional);
    out.add(regional.replace(/\s+/g,""));
  }
  if (base.endsWith(" tv")) out.add(base.slice(0,-3).trim());
  return [...out].filter(Boolean);
}
function significantTokens(value) {
  return new Set(keyVariants(value)[0]?.split(" ").filter((x)=>x.length>1 && !isCountryWord(x) && !["live","channel","sports","sport","tv"].includes(x)) || []);
}
function fuzzyEventMatch(a,b) {
  const aa = significantTokens(a), bb = significantTokens(b);
  if (aa.size < 2 || bb.size < 2) return false;
  let common=0; for (const t of aa) if (bb.has(t)) common++;
  return common >= 2 && common / Math.min(aa.size, bb.size) >= 0.8;
}
function addIndex(map, values, row) {
  for (const value of values) for (const key of keyVariants(value)) {
    const arr = map.get(key) || []; if (!arr.some((x)=>x.id===row.id)) arr.push(row); map.set(key,arr);
  }
}
export function filterSourceRowsByDlhd(sourceRows, reference, aliases = {}) {
  const staticIndex = new Map(), eventTitleIndex = new Map(), eventAliasIndex = new Map();
  for (const ref of reference?.channels || []) addIndex(staticIndex, [ref.name, ...(ref.aliases||[])], ref);
  for (const ref of reference?.events || []) {
    addIndex(eventTitleIndex, [ref.name], ref);
    addIndex(eventAliasIndex, (ref.aliases||[]).slice(1), ref);
  }
  const out = [], matchedRefs = new Set(), matchedInput = new Set();
  const allEvents = reference?.events || [];
  for (let rowIndex=0; rowIndex<(sourceRows||[]).length; rowIndex++) {
    const item = sourceRows[rowIndex];
    const rawNames = [item.row?.tvgName, item.row?.name].filter(Boolean);
    const aliasName = aliases[normalize(strippedChannelName(rawNames[0] || ""))];
    if (aliasName) rawNames.push(aliasName);
    const matches = new Map();
    for (const value of rawNames) {
      for (const key of keyVariants(value)) {
        for (const ref of staticIndex.get(key)||[]) matches.set(ref.id, ref);
        for (const ref of eventTitleIndex.get(key)||[]) matches.set(ref.id, ref);
        for (const ref of eventAliasIndex.get(key)||[]) matches.set(ref.id, ref);
      }
    }
    if (![...matches.values()].some((x)=>x.kind==="event")) {
      for (const value of rawNames) for (const ref of allEvents) {
        if (fuzzyEventMatch(value, ref.name)) matches.set(ref.id, ref);
      }
    }
    for (const ref of matches.values()) {
      out.push({ ...item, reference:ref });
      matchedRefs.add(ref.id); matchedInput.add(rowIndex);
    }
  }
  const allRefs = [...(reference?.channels||[]), ...(reference?.events||[])];
  return {
    rows:out,
    matchedInputRows:matchedInput.size,
    matchedReferences:matchedRefs.size,
    unmatchedReferences:allRefs.filter((ref)=>!matchedRefs.has(ref.id)),
    totalReferences:allRefs.length,
  };
}