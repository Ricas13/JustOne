import { withInternalKey } from "./config.js";
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

  if (/\b(?:nfl|american football|college football)\b/.test(hay)) return "American Football";
  if (/\b(?:basketball|nba|wnba|euroleague|acb)\b/.test(hay)) return "Basketball";
  if (/\b(?:baseball|mlb|beisbol)\b/.test(hay)) return "Baseball";
  if (/\b(?:ice hockey|nhl|khl|mhl|ahl)\b/.test(hay)) return "Ice Hockey";
  if (/\b(?:handball)\b/.test(hay)) return "Handball";
  if (/\b(?:volleyball|volei)\b/.test(hay)) return "Volleyball";
  if (/\b(?:rugby|six nations)\b/.test(hay)) return "Rugby";
  if (/\b(?:cricket|ipl|ashes)\b/.test(hay)) return "Cricket";
  if (/\b(?:tennis|wta|atp|wimbledon|roland garros)\b/.test(hay)) return "Tennis";
  if (/\b(?:golf|pga|lpga|ryder cup)\b/.test(hay)) return "Golf";
  if (/\b(?:formula 1|f1|formula e|motogp|moto gp|nascar|indycar|motorsport|rally|wrc|grand prix|supercars|superbike|gt world)\b/.test(hay)) return "Motorsport";
  if (/\b(?:boxing|mma|ufc|wwe|wrestling|bellator|pfl|fight night)\b/.test(hay)) return "Combat Sports";
  if (/\b(?:athletics|diamond league|track and field|marathon)\b/.test(hay)) return "Athletics";
  if (/\b(?:cycling|tour de|giro d|vuelta)\b/.test(hay)) return "Cycling";
  if (/\b(?:darts|pdc)\b/.test(hay)) return "Darts";
  if (/\b(?:snooker|billiards)\b/.test(hay)) return "Snooker";
  if (/\b(?:rock in rio|festival|concert|music)\b/.test(hay)) return "Music";
  if (/\b(?:jeopardy|tv shows?|premiere|episode|season)\b/.test(hay)) return "TV & Entertainment";

  if (/\b(?:soccer|football|futsal|premier league|champions league|europa league|conference league|la liga|liga i|liga 1|liga 2|serie a|serie b|allsvenskan|superettan|brasileirao|eredivisie|bundesliga|mls|nws|copa|cup|division)\b/.test(hay)) return "Football";

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
    channel: withInternalKey(`http://justone-catalog:8091/artwork/event/channel/${token}.png`),
    programme: withInternalKey(`http://justone-catalog:8091/artwork/event/program/${token}.png`),
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
  const description = event.competition || event.originalCategory || "DLHD scheduled event";
  const rows = [
    `  <channel id="${xmlEscape(channel.tvgId)}">`,
    `    <display-name>${xmlEscape(channel.name)}</display-name>`,
    channel.logo ? `    <icon src="${xmlEscape(channel.logo)}" />` : "",
    "  </channel>",
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEscape(channel.tvgId)}">`,
    `    <title>${xmlEscape(channel.name)}</title>`,
    event.competition ? `    <sub-title>${xmlEscape(event.competition)}</sub-title>` : "",
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : "",
    `    <desc>${xmlEscape(description)}</desc>`,
    event.programmeArtwork ? `    <icon src="${xmlEscape(event.programmeArtwork)}" />` : "",
    "  </programme>",
  ];
  return rows.filter(Boolean).join("\n");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function syncGuideEvents(guideXml, channels) {
  let xml = String(guideXml || "");
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
  const matchedEventIds = new Set(cloned.channels.filter((ch) => ch.referenceKind === "event").map((ch) => ch.dlhdRefId).filter(Boolean));

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
