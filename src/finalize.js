import { countryOf } from "./identity.js";
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

function variantKey(variant) {
  return `${variant.sourceId || ""}|${variant.url || ""}`;
}

function copyVariants(channels) {
  const seen = new Set();
  const out = [];
  for (const channel of channels) {
    for (const variant of channel.variants || []) {
      const key = variantKey(variant);
      if (!variant.url || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...variant });
    }
  }
  return out.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.name || "").localeCompare(String(b.name || "")))
    .map((variant, order) => ({ ...variant, order }));
}

function linkedPlaybackChannels(eventRef, staticChannels) {
  const byDlhdId = new Map();
  const byName = new Map();
  for (const channel of staticChannels) {
    if (channel.dlhdId) byDlhdId.set(String(channel.dlhdId), channel);
    for (const value of [channel.name, ...(channel.aliasNames || [])]) {
      const key = normalize(value);
      if (key && !byName.has(key)) byName.set(key, channel);
    }
  }

  const found = [];
  const seen = new Set();
  for (const linked of eventRef.linkedChannels || []) {
    const channel = byDlhdId.get(String(linked.id || "")) || byName.get(normalize(linked.name || ""));
    if (!channel || seen.has(channel.id) || !(channel.variants || []).length) continue;
    seen.add(channel.id);
    found.push(channel);
  }
  return found;
}

function materializeLinkedEvents(snapshot) {
  const current = snapshot.channels || [];
  const existingEventRefIds = new Set(current.filter((ch) => ch.referenceKind === "event").map((ch) => ch.dlhdRefId).filter(Boolean));
  const staticChannels = current.filter((ch) => ch.referenceKind !== "event");
  const added = [];
  let mappings = 0;

  for (const ref of snapshot.dlhdReference?.events || []) {
    if (existingEventRefIds.has(ref.id)) continue;
    const linked = linkedPlaybackChannels(ref, staticChannels);
    if (!linked.length) continue;
    const variants = copyVariants(linked);
    if (!variants.length) continue;

    const type = eventTypeFor(ref);
    const channel = {
      key: ref.key,
      id: ref.id,
      tvgId: ref.tvgId,
      name: ref.name,
      group: `Events | ${type}`,
      logo: text(ref.logo || linked.find((ch) => ch.logo)?.logo || ""),
      aliasNames: [...new Set([ref.name, ...(ref.aliases || []), ...linked.flatMap((ch) => ch.aliasNames || [])].filter(Boolean))],
      variants,
      referenceKind: "event",
      dlhdRefId: ref.id,
      dlhdId: ref.dlhdId || null,
      linkedChannelFallback: true,
      linkedChannelIds: linked.map((ch) => ch.id),
      event: {
        start: ref.start,
        end: ref.end,
        time: ref.time,
        category: type,
        originalCategory: ref.category,
        linkedChannels: ref.linkedChannels || [],
      },
    };
    mappings += variants.length;
    existingEventRefIds.add(ref.id);
    added.push(channel);
  }

  return { added, mappings };
}

function layoutChannels(channels, overrides = {}, providerOrders = null) {
  for (const channel of channels) {
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (channel.referenceKind === "event") {
      const type = eventTypeFor({ name: channel.name, category: channel.event?.originalCategory || channel.event?.category || channel.group });
      channel.event = { ...(channel.event || {}), category: type };
      if (!override.group) channel.group = `Events | ${type}`;
    } else {
      if (!override.group) {
        const cc = staticCountry(channel);
        if (cc === "GB") channel.group = "TV | UK";
        else if (cc === "PT") channel.group = "TV | PT";
        else if (cc === "US") channel.group = "TV | USA";
      }
      const providerOrder = providerOrderForChannel(channel, providerOrders);
      if (providerOrder) channel.providerOrder = providerOrder;
      else delete channel.providerOrder;
    }
  }

  const staticRows = channels.filter((ch) => ch.referenceKind !== "event").sort((a, b) => {
    const ac = staticCountry(a), bc = staticCountry(b);
    const countryDifference = (COUNTRY_RANK.get(ac) ?? 99) - (COUNTRY_RANK.get(bc) ?? 99);
    if (countryDifference) return countryDifference;
    const ap = Number(a.providerOrder?.position);
    const bp = Number(b.providerOrder?.position);
    const aPosition = Number.isFinite(ap) ? ap : Number.MAX_SAFE_INTEGER;
    const bPosition = Number.isFinite(bp) ? bp : Number.MAX_SAFE_INTEGER;
    return aPosition - bPosition || a.name.localeCompare(b.name);
  });
  const eventRows = channels.filter((ch) => ch.referenceKind === "event").sort((a, b) => {
    const at = eventTypeFor({ name: a.name, category: a.event?.category || a.group });
    const bt = eventTypeFor({ name: b.name, category: b.event?.category || b.group });
    return (EVENT_TYPE_RANK.get(at) ?? 99) - (EVENT_TYPE_RANK.get(bt) ?? 99)
      || eventStart(a) - eventStart(b)
      || a.name.localeCompare(b.name);
  });

  // Keep the country blocks stable for Jellyfin while provider positions decide
  // the order within each block. We intentionally do not expose raw provider
  // channel numbers because US local and national providers can reuse numbers.
  const nextByCountry = new Map([["GB", 1000], ["PT", 2000], ["US", 3000]]);
  for (const channel of staticRows) {
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (Number(override.number) > 0) { channel.number = Number(override.number); continue; }
    const cc = staticCountry(channel);
    const next = nextByCountry.get(cc) ?? 4000;
    channel.number = next;
    nextByCountry.set(cc, next + 1);
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
  const rows = [
    `  <channel id="${xmlEscape(channel.tvgId)}">`,
    `    <display-name>${xmlEscape(channel.name)}</display-name>`,
    channel.logo ? `    <icon src="${xmlEscape(channel.logo)}" />` : "",
    "  </channel>",
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEscape(channel.tvgId)}">`,
    `    <title>${xmlEscape(channel.name)}</title>`,
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : "",
    `    <desc>${xmlEscape("DLHD schedule reference; playback is supplied by a linked configured IPTV channel.")}</desc>`,
    channel.logo ? `    <icon src="${xmlEscape(channel.logo)}" />` : "",
    "  </programme>",
  ];
  return rows.filter(Boolean).join("\n");
}

export function augmentGuideWithEvents(guideXml, channels) {
  const additions = [];
  for (const channel of channels) {
    if (!channel?.tvgId || String(guideXml).includes(`id="${channel.tvgId}"`)) continue;
    const xml = eventXml(channel);
    if (xml) additions.push(xml);
  }
  if (!additions.length) return guideXml;
  return String(guideXml).replace(/\s*<\/tv>\s*$/i, `\n${additions.join("\n")}\n</tv>\n`);
}

export function finalizeSnapshot(snapshot, state = {}, { providerOrders = null } = {}) {
  const cloned = structuredClone(snapshot || {});
  cloned.channels = cloned.channels || [];
  const fallback = materializeLinkedEvents(cloned);
  cloned.channels.push(...fallback.added);
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
    cloned.dlhdStatus.linkedChannelFallbackEvents = fallback.added.length;
    cloned.dlhdStatus.linkedChannelFallbackMappings = fallback.mappings;
    cloned.dlhdStatus.outputMappings = Number(cloned.dlhdStatus.outputMappings || 0) + fallback.mappings;
    cloned.dlhdStatus.outputStaticChannels = staticCount;
    cloned.dlhdStatus.outputEvents = eventCount;
    cloned.dlhdStatus.matchedChannelReferences = matchedStaticIds.size;
    cloned.dlhdStatus.matchedEventReferences = matchedEventIds.size;
    cloned.dlhdStatus.matchedReferences = matchedStaticIds.size + matchedEventIds.size;
    const matched = new Set([...matchedStaticIds, ...matchedEventIds]);
    cloned.dlhdStatus.unmatchedReferences = (cloned.dlhdStatus.unmatchedReferences || []).filter((ref) => !matched.has(ref.id));
  }

  return { snapshot: cloned, addedEvents: fallback.added };
}

export { EVENT_TYPE_ORDER };
