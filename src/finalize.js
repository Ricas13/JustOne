import { config, withInternalKey } from "./config.js";
import { needsSportsTag } from "./guide-categories.js";
import { countryGroup, countryName, countryOf } from "./identity.js";
import { providerOrderForChannel } from "./provider-order.js";
import { normalize, text, xmlEscape } from "./util.js";

const EVENT_TYPE_ORDER = [
  "Football",
  "American Football",
  "Basketball",
  "Baseball",
  "Ice Hockey",
  "Tennis",
  "Golf",
  "Motorsport",
  "Rugby",
  "Cricket",
  "Combat Sports",
  "Handball",
  "Volleyball",
  "Athletics",
  "Cycling",
  "Darts",
  "Snooker",
  "Music",
  "TV & Entertainment",
  "Other",
];
const EVENT_TYPE_RANK = new Map(EVENT_TYPE_ORDER.map((name, index) => [name, index]));
const COUNTRY_RANK = new Map([["GB", 0], ["PT", 1], ["US", 2]]);

export function eventTypeFor(ref = {}) {
  const hay = normalize(`${ref.category || ""} ${ref.name || ref.title || ""}`);

  if (/\b(?:nfl|american football|college football|bowl)\b/.test(hay)) return "American Football";
  if (/\b(?:basketball|nba|wnba|euroleague|acb|vtb united league|liga femenina|eurocup|baloncesto)\b/.test(hay)) return "Basketball";
  if (/\b(?:baseball|mlb|beisbol)\b/.test(hay)) return "Baseball";
  if (/\b(?:ice hockey|nhl|khl|mhl|ahl|echl|qmjhl|ohl|ushl|whl|euro hockey tour)\b/.test(hay)) return "Ice Hockey";
  if (/\b(?:handball)\b/.test(hay)) return "Handball";
  if (/\b(?:volleyball|volei)\b/.test(hay)) return "Volleyball";
  if (/\b(?:rugby|six nations)\b/.test(hay)) return "Rugby";
  if (/\b(?:cricket|ipl|ashes)\b/.test(hay)) return "Cricket";
  if (/\b(?:tennis|wta|atp|roland garros)\b|(?<!afc )\bwimbledon\b/.test(hay)) return "Tennis";
  if (/\b(?:golf|pga|lpga|ryder cup)\b/.test(hay)) return "Golf";
  if (/\b(?:formula 1|f1|formula e|motogp|moto gp|nascar|indycar|motorsport|rally|wrc|grand prix|supercars|superbike|gt world)\b/.test(hay)) return "Motorsport";
  if (/\b(?:boxing|mma|ufc|wwe|wrestling|bellator|pfl|fight night)\b/.test(hay)) return "Combat Sports";
  if (/\b(?:athletics|diamond league|track and field|marathon)\b/.test(hay)) return "Athletics";
  if (/\b(?:cycling|tour de|giro d|vuelta)\b/.test(hay)) return "Cycling";
  if (/\b(?:darts|pdc)\b/.test(hay)) return "Darts";
  if (/\b(?:snooker|billiards)\b/.test(hay)) return "Snooker";
  // Named top-flight competitions beat ambiguous entertainment words ("Premier League Season Preview").
  if (/\b(?:premier league|champions league|europa league|la liga|bundesliga|serie a|ligue 1)\b/.test(hay)) return "Football";
  if (/\b(?:rock in rio|festival|concert|music|coachella|tomorrowland|glastonbury)\b/.test(hay)) return "Music";
  if (/\b(?:jeopardy|tv shows?|premiere|episode|season)\b/.test(hay)) return "TV & Entertainment";

  if (/\b(?:soccer|football|futsal|premier league|champions league|europa league|conference league|la liga|liga i|liga 1|liga 2|serie a|serie b|allsvenskan|superettan|brasileirao|eredivisie|bundesliga|mls|nws|copa|cup|division|league one|league two|national league|eerste divisie|challenger pro league|pro league|primeira liga|segunda liga|serie [abc]|ligue [123]|eliteserien|ekstraklasa|i liga|prva liga|botola|premiership|nwsl|a league|k league|j league|fc|afc|liga)\b/.test(hay)) return "Football";

  return "Other";
}

function staticCountry(channel) {
  return countryOf({ name: channel?.name || "", group: channel?.group || "" });
}

function eventStart(channel) {
  const value = Number(channel?.event?.start);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stripEventDecorations(value) {
  return String(value || "")
    .replace(/[\p{Regional_Indicator}\p{Extended_Pictographic}\uFE0F]/gu, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function eventPresentation(value) {
  const clean = stripEventDecorations(value);
  const colon = clean.lastIndexOf(":");
  const prefix = colon > 0 ? clean.slice(0, colon).trim() : "";
  const tail = colon > 0 ? clean.slice(colon + 1).trim() : clean;
  const matchup = /\b(?:vs\.?|v\.?|@|x)\b/i.test(tail);
  const genericPrefix = /^(?:soccer|football|futsal|tennis|basketball|baseball|ice hockey|hockey|handball|volleyball|rugby|cricket|boxing|mma|golf|motorsport|events?)\b/i.test(prefix);
  const title = (matchup || genericPrefix) && tail ? tail : clean;
  return {
    title: title || clean || "Live Event",
    competition: prefix && prefix !== title ? prefix : "",
  };
}

function eventArtworkUrls(channel) {
  const token = encodeURIComponent(String(channel.id || channel.tvgId || "event"));
  return {
    channel: withInternalKey(`${config.internalBaseUrl}/artwork/event/channel/${token}.png`),
    programme: withInternalKey(`${config.internalBaseUrl}/artwork/event/program/${token}.png`),
  };
}

function layoutChannels(channels, overrides = {}, providerOrders = null) {
  for (const channel of channels) {
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (channel.referenceKind === "event") {
      const originalName = text(channel.event?.originalName || channel.name);
      const type = eventTypeFor({ name: originalName, category: channel.event?.originalCategory || channel.event?.category || channel.group });
      const presentation = eventPresentation(originalName);
      const previousName = channel.name;
      channel.event = {
        ...(channel.event || {}),
        category: type,
        originalName,
        competition: presentation.competition,
      };
      channel.aliasNames = [...new Set([...(channel.aliasNames || []), originalName, previousName].filter(Boolean))];
      if (!override.name) channel.name = presentation.title;
      else channel.name = text(override.name);
      if (!override.group) channel.group = `Events | ${type}`;
      const artwork = eventArtworkUrls(channel);
      channel.event.channelArtwork = artwork.channel;
      channel.event.programmeArtwork = artwork.programme;
      channel.logo = text(override.logo || artwork.channel);
    } else {
      if (!override.group) channel.group = countryGroup(staticCountry(channel));
      const providerOrder = providerOrderForChannel(channel, providerOrders);
      if (providerOrder) channel.providerOrder = providerOrder;
      else delete channel.providerOrder;
    }
  }

  const staticRows = channels.filter((ch) => ch.referenceKind !== "event").sort((a, b) => {
    const ac = staticCountry(a), bc = staticCountry(b);
    const aRank = COUNTRY_RANK.get(ac) ?? 3;
    const bRank = COUNTRY_RANK.get(bc) ?? 3;
    if (aRank !== bRank) return aRank - bRank;

    // UK, Portugal and USA retain their curated provider order. Every other
    // country follows as a stable country block, alphabetically by country then
    // channel name. Unknown/International channels sort last.
    if (aRank === 3) {
      const aCountry = countryName(ac) || (ac ? ac : "ZZZ International");
      const bCountry = countryName(bc) || (bc ? bc : "ZZZ International");
      const byCountry = aCountry.localeCompare(bCountry);
      if (byCountry) return byCountry;
    }

    const ap = Number(a.providerOrder?.position);
    const bp = Number(b.providerOrder?.position);
    const aPosition = Number.isFinite(ap) ? ap : Number.MAX_SAFE_INTEGER;
    const bPosition = Number.isFinite(bp) ? bp : Number.MAX_SAFE_INTEGER;
    return aPosition - bPosition || a.name.localeCompare(b.name);
  });
  const eventRows = channels.filter((ch) => ch.referenceKind === "event").sort((a, b) => {
    const at = eventTypeFor({ name: a.event?.originalName || a.name, category: a.event?.category || a.group });
    const bt = eventTypeFor({ name: b.event?.originalName || b.name, category: b.event?.category || b.group });
    return (EVENT_TYPE_RANK.get(at) ?? 99) - (EVENT_TYPE_RANK.get(bt) ?? 99)
      || eventStart(a) - eventStart(b)
      || a.name.localeCompare(b.name);
  });

  const nextByCountry = new Map([["GB", 1000], ["PT", 2000], ["US", 3000]]);
  let nextInternational = 4000;
  for (const channel of staticRows) {
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (Number(override.number) > 0) { channel.number = Number(override.number); continue; }
    const cc = staticCountry(channel);
    if (nextByCountry.has(cc)) {
      channel.number = nextByCountry.get(cc);
      nextByCountry.set(cc, channel.number + 1);
    } else {
      channel.number = nextInternational++;
    }
  }
  let eventNumber = 90000;
  for (const channel of eventRows) {
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (Number(override.number) > 0) channel.number = Number(override.number);
    else channel.number = eventNumber++;
  }

  return [...staticRows, ...eventRows];
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

function eventXml(channel) {
  const event = channel.event || {};
  if (!Number.isFinite(Number(event.start))) return "";
  const start = Number(event.start);
  const end = Number.isFinite(Number(event.end)) ? Number(event.end) : start + 3 * 60 * 60 * 1000;
  const description = event.source === "provider"
    ? [event.competition || event.originalCategory || "Live event", event.timeEstimated ? "(start time estimated)" : ""].filter(Boolean).join(" ")
    : event.competition || event.originalCategory || "DLHD scheduled event";
  const rows = [
    `  <channel id="${xmlEscape(channel.tvgId)}">`,
    `    <display-name>${xmlEscape(channel.name)}</display-name>`,
    channel.logo ? `    <icon src="${xmlEscape(channel.logo)}" />` : "",
    "  </channel>",
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEscape(channel.tvgId)}">`,
    `    <title>${xmlEscape(channel.name)}</title>`,
    event.competition ? `    <sub-title>${xmlEscape(event.competition)}</sub-title>` : "",
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : "",
    config.guideCategories.enabled && needsSportsTag(event.category, event.originalName || event.name || channel.name) ? "    <category>Sports</category>" : "",
    `    <desc>${xmlEscape(description)}</desc>`,
    event.programmeArtwork ? `    <icon src="${xmlEscape(event.programmeArtwork)}" />` : "",
    "  </programme>",
  ];
  return rows.filter(Boolean).join("\n");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Provider-only events use the "justone.pevent." id prefix. A preserved
// last-known-good guide can still carry ones that have since expired or been
// switched off, so they are removed here unless they are currently published.
/**
 * Index just past the `>` that closes the tag starting at `from`, honouring quoted attribute
 * values (which may contain `>`), plus the attribute text and whether the tag is self-closing.
 */
function readTag(xml, from) {
  let quote = "";
  for (let i = from + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") {
      const inner = xml.slice(from + 1, i);
      return { end: i + 1, selfClosing: inner.endsWith("/"), attrs: inner.replace(/^[^\s/>]+/, "") };
    }
  }
  return null;
}

/** Skip a comment, CDATA section, processing instruction or declaration starting at `from`; -1 if `from` is none of those. */
function skipMarkup(xml, from) {
  const closers = [["<!--", "-->"], ["<![CDATA[", "]]>"], ["<?", "?>"], ["<!", ">"]];
  for (const [open, close] of closers) {
    if (!xml.startsWith(open, from)) continue;
    const end = xml.indexOf(close, from + open.length);
    return end < 0 ? xml.length : end + close.length;
  }
  return -1;
}

/** Index just past the closing tag of `name` that follows `from`, skipping comments and CDATA; -1 if there is none. */
function findClosingTag(xml, from, name) {
  const needle = `</${name}`;
  for (let i = xml.indexOf("<", from); i >= 0; i = xml.indexOf("<", i + 1)) {
    const skipped = skipMarkup(xml, i);
    if (skipped >= 0) { i = skipped - 1; continue; }
    if (xml.startsWith(needle, i) && /[\s>]/.test(xml[i + needle.length] || ">")) {
      const gt = xml.indexOf(">", i);
      return gt < 0 ? -1 : gt + 1;
    }
  }
  return -1;
}

function attributeValue(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
}

// Provider-only events use the "justone.pevent." id prefix. A preserved
// last-known-good guide can still carry ones that have since expired or been
// switched off, so they are removed here unless they are currently published.
// One linear pass over the document: elements are found by walking tags (not by
// pattern-matching text), so comments, CDATA, self-closing tags, quoted ">" and
// lookalike attributes (data-id, backup-channel) cannot make it delete anything else.
export function removeStaleProviderEvents(guideXml, channels) {
  const xml = String(guideXml || "");
  if (!xml.includes("justone.pevent.")) return xml;
  const live = new Set((channels || []).filter((channel) => channel?.referenceKind === "event").map((channel) => channel.tvgId));
  const stale = (id) => typeof id === "string" && id.startsWith("justone.pevent.") && !live.has(id);
  const out = [];
  let copiedTo = 0;
  const unclosed = new Set(); // element names with no closing tag anywhere after this point
  let i = 0;
  while ((i = xml.indexOf("<", i)) >= 0) {
    const skipped = skipMarkup(xml, i);
    if (skipped >= 0) { i = skipped; continue; }
    const m = /^<(channel|programme)(?=[\s/>])/.exec(xml.slice(i, i + 12));
    if (!m) { i += 1; continue; }
    const name = m[1];
    const tag = readTag(xml, i);
    if (!tag) break;
    let end = tag.end;
    if (!tag.selfClosing) {
      if (unclosed.has(name)) { i = tag.end; continue; }
      end = findClosingTag(xml, tag.end, name);
      if (end < 0) { unclosed.add(name); i = tag.end; continue; }
    }
    if (stale(attributeValue(tag.attrs, name === "channel" ? "id" : "channel"))) {
      out.push(xml.slice(copiedTo, i));
      const trailing = /^[ \t]*\r?\n?/.exec(xml.slice(end, end + 8))[0].length;
      copiedTo = end + trailing;
      i = copiedTo;
    } else {
      i = end;
    }
  }
  out.push(xml.slice(copiedTo));
  return out.join("");
}

export function syncGuideEvents(guideXml, channels) {
  let xml = removeStaleProviderEvents(guideXml, channels);
  const events = (channels || []).filter((channel) => channel?.referenceKind === "event" && channel?.tvgId);
  for (const channel of events) {
    const id = regexEscape(channel.tvgId);
    const channelRe = new RegExp(`\\s*<channel\\b[^>]*\\bid=(?:"${id}"|'${id}')[^>]*>[\\s\\S]*?<\\/channel>\\s*`, "gi");
    const programmeRe = new RegExp(`\\s*<programme\\b(?=[^>]*\\bchannel=(?:"${id}"|'${id}'))[^>]*>[\\s\\S]*?<\\/programme>\\s*`, "gi");
    xml = xml.replace(channelRe, "\n").replace(programmeRe, "\n");
  }
  const additions = events.map(eventXml).filter(Boolean);
  if (!additions.length) return xml;
  return xml.replace(/\s*<\/tv>\s*$/i, `\n${additions.join("\n")}\n</tv>\n`);
}

export function augmentGuideWithEvents(guideXml, channels) {
  return syncGuideEvents(guideXml, channels);
}

export function finalizeSnapshot(snapshot, state = {}, { providerOrders = null } = {}) {
  const cloned = structuredClone(snapshot || {});
  cloned.channels = cloned.channels || [];
  cloned.channels = layoutChannels(cloned.channels, state.overrides || {}, providerOrders);

  const staticCount = cloned.channels.filter((ch) => ch.referenceKind !== "event").length;
  const eventCount = cloned.channels.filter((ch) => ch.referenceKind === "event").length;
  const matchedStaticIds = new Set(cloned.channels.filter((ch) => ch.referenceKind !== "event").map((ch) => ch.dlhdRefId).filter(Boolean));
  const matchedEventIds = new Set(cloned.channels.filter((ch) => ch.referenceKind === "event" && ch.event?.source !== "provider").map((ch) => ch.dlhdRefId).filter(Boolean));

  const orderingSummary = {};
  for (const [cc, label] of [["GB","UK"],["PT","PT"],["US","USA"]]) {
    const rows = cloned.channels.filter((ch) => ch.referenceKind !== "event" && staticCountry(ch) === cc);
    orderingSummary[label] = {
      provider: providerOrders?.metadata?.[cc]?.provider || null,
      source: providerOrders?.metadata?.[cc]?.source || null,
      matched: rows.filter((ch) => ch.providerOrder).length,
      unmatched: rows.filter((ch) => !ch.providerOrder).length,
      total: rows.length,
    };
  }
  cloned.lineupOrdering = orderingSummary;

  if (cloned.dlhdStatus) {
    cloned.dlhdStatus.linkedChannelFallbackEvents = 0;
    cloned.dlhdStatus.linkedChannelFallbackMappings = 0;
    cloned.dlhdStatus.linearScheduleEvents = cloned.dlhdReference?.linearEvents?.length || 0;
    cloned.dlhdStatus.outputStaticChannels = staticCount;
    cloned.dlhdStatus.outputEvents = eventCount;
    cloned.dlhdStatus.matchedChannelReferences = matchedStaticIds.size;
    cloned.dlhdStatus.matchedEventReferences = matchedEventIds.size;
    cloned.dlhdStatus.matchedReferences = matchedStaticIds.size + matchedEventIds.size;
    const matched = new Set([...matchedStaticIds, ...matchedEventIds]);
    cloned.dlhdStatus.unmatchedReferences = (cloned.dlhdStatus.unmatchedReferences || []).filter((ref) => !matched.has(ref.id));
  }

  return { snapshot: cloned, addedEvents: [] };
}

export { EVENT_TYPE_ORDER };
