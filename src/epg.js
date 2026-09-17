import { normalize, stripTags, text, xmlDecode, xmlEscape } from "./util.js";

export function isGeneratedJustOneGuide(body) {
  const source = String(body || "");
  const tvTag = /<tv\b[^>]*>/i.exec(source)?.[0] || "";
  const match = /\bgenerator-info-name\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tvTag);
  return normalize(match?.[1] ?? match?.[2] ?? "") === "justone catalog";
}

export function parseXmlTv(body) {
  const source = String(body || "");
  const channels = new Map();
  const names = new Map();
  const programmes = new Map();

  // Canonical JustOne XMLTV is output, never input. Throwing here is deliberate:
  // catalog refresh catches the rejection and therefore cannot silently append
  // guide.xml to the upstream guide set after an XMLTV provider failure.
  if (isGeneratedJustOneGuide(source)) {
    throw new Error("refusing generated JustOne guide as upstream XMLTV");
  }

  let match;
  const channelRe = /<channel\b[^>]*\bid=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/channel>/gi;
  while ((match = channelRe.exec(source))) {
    const id = xmlDecode(match[1] ?? match[2] ?? "");
    const inner = match[3];
    const display = [...inner.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi)]
      .map((m) => stripTags(m[1])).filter(Boolean);
    const iconMatch = /<icon\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')/i.exec(inner);
    const icon = xmlDecode(iconMatch?.[1] ?? iconMatch?.[2] ?? "");
    channels.set(id, { id, display, icon });
    for (const name of display) {
      const key = normalize(name);
      if (key && !names.has(key)) names.set(key, id);
    }
  }

  const programRe = /<programme\b[\s\S]*?<\/programme>/gi;
  while ((match = programRe.exec(source))) {
    const full = match[0];
    const idMatch = /\bchannel=(?:"([^"]+)"|'([^']+)')/i.exec(full);
    const id = xmlDecode(idMatch?.[1] ?? idMatch?.[2] ?? "");
    if (!id) continue;
    const arr = programmes.get(id) || [];
    arr.push(full);
    programmes.set(id, arr);
  }

  return { channels, names, programmes, generatedByJustOne: false };
}

export function parseXmlTvTime(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", sign, offHour = "00", offMinute = "00"] = match;
  let ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (sign) {
    const offset = (Number(offHour) * 60 + Number(offMinute)) * 60 * 1000;
    ms += sign === "+" ? -offset : offset;
  }
  return Number.isFinite(ms) ? ms : null;
}

export function programmeHint(programme) {
  const full = String(programme || "");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(full);
  const subTitleMatch = /<sub-title\b[^>]*>([\s\S]*?)<\/sub-title>/i.exec(full);
  const startMatch = /\bstart=(?:"([^"]+)"|'([^']+)')/i.exec(full);
  const stopMatch = /\bstop=(?:"([^"]+)"|'([^']+)')/i.exec(full);
  const title = stripTags(titleMatch?.[1] || "");
  const subTitle = stripTags(subTitleMatch?.[1] || "");
  return {
    title,
    subTitle,
    start: parseXmlTvTime(startMatch?.[1] ?? startMatch?.[2] ?? ""),
    stop: parseXmlTvTime(stopMatch?.[1] ?? stopMatch?.[2] ?? ""),
  };
}

export function epgHintsForChannelId(parsed, channelId) {
  const id = String(channelId || "");
  if (!id || !parsed) return { displayNames: [], programmes: [] };
  const meta = parsed.channels?.get(id);
  const displayNames = [...new Set((meta?.display || []).filter(Boolean))];
  const programmes = (parsed.programmes?.get(id) || [])
    .map(programmeHint)
    .filter((row) => row.title || row.subTitle);
  return { displayNames, programmes };
}

function findHit(channel, docs) {
  const ids = new Set((channel.variants || []).map((v) => v.originalTvgId).filter(Boolean));
  for (const doc of docs) {
    for (const id of ids) {
      if (doc.parsed.channels.has(id)) return { doc, sourceId: id, meta: doc.parsed.channels.get(id) };
    }
  }
  const nameKeys = [channel.name, ...(channel.aliasNames || [])].map(normalize).filter(Boolean);
  for (const doc of docs) {
    for (const key of nameKeys) {
      const id = doc.parsed.names.get(key);
      if (id) return { doc, sourceId: id, meta: doc.parsed.channels.get(id) };
    }
  }
  return null;
}

function remapProgramme(programme, tvgId, fallbackImage = "") {
  let out = String(programme || "")
    .replace(/\bchannel=(?:"[^"]+"|'[^']+')/i, `channel="${xmlEscape(tvgId)}"`);

  // Restore the original JustOne programme-artwork behaviour for linear TV.
  // Preserve any real upstream programme artwork first. Jellyfin's Live TV home
  // cards understand XMLTV <image> more reliably than a programme <icon>, so
  // promote an upstream icon to a backdrop image when one is not already there.
  const iconMatch = /<icon\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')/i.exec(out);
  let image = xmlDecode(iconMatch?.[1] ?? iconMatch?.[2] ?? "");
  const hasImage = /<image\b/i.test(out);

  // Some provider guides have schedule data but no per-programme artwork. In
  // that case use the official channel logo instead of Jellyfin's generic TV
  // placeholder. This is only a visual fallback; the real programme metadata is
  // otherwise left untouched.
  if (!image && !hasImage && fallbackImage) {
    image = fallbackImage;
    out = out.replace(/<\/programme>/i, `  <icon src="${xmlEscape(image)}" />\n</programme>`);
  }

  if (!hasImage && image) {
    out = out.replace(
      /<\/programme>/i,
      `  <image type="backdrop" size="3" orient="L">${xmlEscape(image)}</image>\n</programme>`,
    );
  }

  return out;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (![aStart, aEnd, bStart, bEnd].every((value) => Number.isFinite(Number(value)))) return false;
  return Number(aStart) < Number(bEnd) && Number(bStart) < Number(aEnd);
}

function generatedLinearProgramme(event, channel) {
  if (!Number.isFinite(Number(event?.start))) return null;
  const start = Number(event.start);
  const end = Number.isFinite(Number(event.end)) ? Number(event.end) : start + 3 * 60 * 60 * 1000;
  const logo = text(event.logo || channel.logo || "");
  return [
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEscape(channel.tvgId)}">`,
    `    <title>${xmlEscape(event.name || "Live Event")}</title>`,
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : "",
    `    <desc>${xmlEscape("DLHD schedule reference for this linear channel.")}</desc>`,
    logo ? `    <icon src="${xmlEscape(logo)}" />` : "",
    "  </programme>",
  ].filter(Boolean).join("\n");
}

function generatedEventProgramme(channel) {
  const event = channel.event;
  if (!event || !Number.isFinite(Number(event.start))) return null;
  const start = Number(event.start);
  const end = Number.isFinite(Number(event.end)) ? Number(event.end) : start + 3 * 60 * 60 * 1000;
  return [
    `  <programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="${xmlEscape(channel.tvgId)}">`,
    `    <title>${xmlEscape(channel.name)}</title>`,
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : "",
    `    <desc>${xmlEscape("DLHD schedule reference; playback is supplied by configured IPTV providers.")}</desc>`,
    channel.logo ? `    <icon src="${xmlEscape(channel.logo)}" />` : "",
    "  </programme>",
  ].filter(Boolean).join("\n");
}

export function enrichAndBuildGuide(channels, docs, overrides = {}, { dlhdReference = null } = {}) {
  const hits = new Map();
  const linearEventsByChannel = new Map();
  for (const event of dlhdReference?.linearEvents || []) {
    for (const linked of event.linkedStaticChannels || []) {
      const key = String(linked.id || "");
      if (!key) continue;
      const rows = linearEventsByChannel.get(key) || [];
      rows.push(event);
      linearEventsByChannel.set(key, rows);
    }
  }
  for (const rows of linearEventsByChannel.values()) {
    rows.sort((a, b) => Number(a.start || 0) - Number(b.start || 0) || String(a.name || "").localeCompare(String(b.name || "")));
  }

  for (const channel of channels) {
    const hit = findHit(channel, docs);
    if (hit) hits.set(channel.id, hit);
    const override = overrides[channel.id] || overrides[channel.key] || {};
    const dlhdLogo = text(channel.logo || "");
    if (override.logo) channel.logo = override.logo;
    else if (dlhdLogo) channel.logo = dlhdLogo;
    else if (hit?.meta?.icon) channel.logo = hit.meta.icon;
    if (!channel.logo) channel.logo = channel.variants.find((v) => v.logo)?.logo || "";
    const linearEventCount = linearEventsByChannel.get(String(channel.dlhdRefId || ""))?.length || 0;
    channel.epg = channel.referenceKind === "event"
      ? { generated: "dlhd-schedule" }
      : (hit
        ? { guideId: hit.doc.id, sourceId: hit.sourceId, dlhdScheduleFallbacks: linearEventCount }
        : (linearEventCount ? { generated: "dlhd-linear-schedule", dlhdScheduleFallbacks: linearEventCount } : null));
  }

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="JustOne Catalog" generator-info-url="https://github.com/Ricas13/JustOne">',
  ];

  for (const channel of channels) {
    out.push(`  <channel id="${xmlEscape(channel.tvgId)}">`);
    out.push(`    <display-name>${xmlEscape(channel.name)}</display-name>`);
    if (channel.logo) out.push(`    <icon src="${xmlEscape(channel.logo)}" />`);
    out.push("  </channel>");
  }

  for (const channel of channels) {
    if (channel.referenceKind === "event") {
      const generated = generatedEventProgramme(channel);
      if (generated) out.push(generated);
      continue;
    }
    const hit = hits.get(channel.id);
    const upstreamProgrammes = hit ? (hit.doc.parsed.programmes.get(hit.sourceId) || []) : [];
    const fallbackImage = channel.logo || hit?.meta?.icon || "";
    for (const programme of upstreamProgrammes) {
      out.push(remapProgramme(programme, channel.tvgId, fallbackImage));
    }

    // DLHD schedule events that belong to an ordinary 24/7 channel are used as
    // EPG gap-fill only. If real XMLTV already covers that time slot, keep the
    // provider programme and do not create a duplicate.
    const hints = upstreamProgrammes.map(programmeHint);
    for (const event of linearEventsByChannel.get(String(channel.dlhdRefId || "")) || []) {
      const eventStart = Number(event.start);
      const eventEnd = Number.isFinite(Number(event.end)) ? Number(event.end) : eventStart + 3 * 60 * 60 * 1000;
      if (!Number.isFinite(eventStart)) continue;
      const covered = hints.some((programme) => rangesOverlap(eventStart, eventEnd, programme.start, programme.stop));
      if (covered) continue;
      const generated = generatedLinearProgramme(event, channel);
      if (generated) out.push(generated);
    }
  }

  out.push("</tv>");
  return `${out.join("\n")}\n`;
}

export function guideSummary(docs) {
  return docs.map((doc) => ({
    id: doc.id,
    name: doc.name,
    channelCount: doc.parsed.channels.size,
    programmeChannelCount: doc.parsed.programmes.size,
  }));
}
