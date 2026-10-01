import { normalize, stripTags, text, xmlDecode, xmlEscape } from "./util.js";

const EPG_QUALITY_SUFFIXES = new Set(["hd", "fhd", "uhd", "4k", "sd", "hevc", "h264", "h265", "1080p", "720p", "2160p"]);

function relaxedChannelName(value) {
  const parts = normalize(value).split(" ").filter(Boolean);
  while (parts.length > 1 && EPG_QUALITY_SUFFIXES.has(parts.at(-1))) parts.pop();
  return parts.join(" ");
}

function addRelaxedName(map, key, id) {
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, id);
    return;
  }
  if (map.get(key) !== id) map.set(key, null);
}

export function isPlaceholderProgrammeTitle(value) {
  const key = normalize(value);
  return new Set([
    "programa a definir",
    "programacao a definir",
    "a definir",
    "programa por definir",
    "programacao por definir",
    "program to be announced",
    "programme to be announced",
    "to be announced",
    "to be confirmed",
    "tba",
    "tbd",
    "no information",
    "no programme information",
    "sem informacao",
    "programacao indisponivel",
    "sin informacion",
    "sin informacion disponible",
  ]).has(key);
}

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
  const relaxedNames = new Map();
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
      const relaxed = relaxedChannelName(name);
      if (relaxed) addRelaxedName(relaxedNames, relaxed, id);
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

  return { channels, names, relaxedNames, programmes, generatedByJustOne: false };
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

function programmeQuality(programmes, now = Date.now()) {
  const hints = (programmes || []).map(programmeHint);
  const future = hints.filter((row) => {
    const end = Number.isFinite(Number(row.stop)) ? Number(row.stop) : Number(row.start);
    return Number.isFinite(end) && end >= now - 5 * 60 * 1000;
  });
  const real = future.filter((row) => !isPlaceholderProgrammeTitle(row.title));
  const placeholder = future.filter((row) => isPlaceholderProgrammeTitle(row.title));
  const realCoverageMs = real.reduce((total, row) => {
    if (!Number.isFinite(Number(row.start)) || !Number.isFinite(Number(row.stop))) return total;
    return total + Math.max(0, Number(row.stop) - Math.max(now, Number(row.start)));
  }, 0);
  const horizonMs = future.reduce((max, row) => {
    const end = Number.isFinite(Number(row.stop)) ? Number(row.stop) : Number(row.start);
    return Number.isFinite(end) ? Math.max(max, end - now) : max;
  }, 0);
  return {
    futureProgrammes: future.length,
    realFutureProgrammes: real.length,
    placeholderFutureProgrammes: placeholder.length,
    realCoverageMs,
    horizonMs,
  };
}

function compareGuideCandidates(a, b) {
  const aq = a.quality;
  const bq = b.quality;
  const aHasReal = aq.realFutureProgrammes > 0;
  const bHasReal = bq.realFutureProgrammes > 0;
  if (aHasReal !== bHasReal) return aHasReal ? -1 : 1;
  if (a.matchKind !== b.matchKind) return a.matchKind === "id" ? -1 : 1;
  if (aq.realCoverageMs !== bq.realCoverageMs) return bq.realCoverageMs - aq.realCoverageMs;
  if (aq.realFutureProgrammes !== bq.realFutureProgrammes) return bq.realFutureProgrammes - aq.realFutureProgrammes;
  if (a.sourceAffinity !== b.sourceAffinity) return a.sourceAffinity ? -1 : 1;
  if (aq.placeholderFutureProgrammes !== bq.placeholderFutureProgrammes) return aq.placeholderFutureProgrammes - bq.placeholderFutureProgrammes;
  if (aq.horizonMs !== bq.horizonMs) return bq.horizonMs - aq.horizonMs;
  const ap = Number.isFinite(Number(a.doc.priority)) ? Number(a.doc.priority) : 100;
  const bp = Number.isFinite(Number(b.doc.priority)) ? Number(b.doc.priority) : 100;
  if (ap !== bp) return ap - bp;
  return a.docOrder - b.docOrder;
}

function findHits(channel, docs) {
  const candidates = new Map();
  const variants = channel.variants || [];
  const anyVariantSource = new Set(variants.map((row) => String(row.sourceId || "")).filter(Boolean));

  function add(doc, sourceId, matchKind, sourceAffinity, docOrder) {
    if (!sourceId || !doc?.parsed?.channels?.has(sourceId)) return;
    const key = `${doc.id}|${sourceId}`;
    const existing = candidates.get(key);
    const quality = programmeQuality(doc.parsed.programmes.get(sourceId) || []);
    const next = {
      doc,
      sourceId,
      meta: doc.parsed.channels.get(sourceId),
      matchKind,
      sourceAffinity,
      docOrder,
      quality,
    };
    if (!existing) {
      candidates.set(key, next);
      return;
    }
    existing.sourceAffinity ||= sourceAffinity;
    if (matchKind === "id") existing.matchKind = "id";
  }

  docs.forEach((doc, docOrder) => {
    for (const variant of variants) {
      const id = String(variant.originalTvgId || "");
      if (!id || !doc.parsed.channels.has(id)) continue;
      add(doc, id, "id", Boolean(doc.sourceId) && String(doc.sourceId) === String(variant.sourceId || ""), docOrder);
    }
  });

  const rawNames = [channel.name, ...(channel.aliasNames || []), ...variants.map((row) => row.name)].filter(Boolean);
  const exactNameKeys = [...new Set(rawNames.map(normalize).filter(Boolean))];
  const relaxedNameKeys = [...new Set(rawNames.map(relaxedChannelName).filter(Boolean))];

  docs.forEach((doc, docOrder) => {
    const affinity = Boolean(doc.sourceId) && anyVariantSource.has(String(doc.sourceId));
    for (const key of exactNameKeys) {
      const id = doc.parsed.names.get(key);
      if (id) add(doc, id, "name", affinity, docOrder);
    }
    for (const key of relaxedNameKeys) {
      const id = doc.parsed.relaxedNames?.get(key);
      if (id) add(doc, id, "name", affinity, docOrder);
    }
  });

  return [...candidates.values()].sort(compareGuideCandidates);
}


function mergedProgrammesForHits(hits) {
  const accepted = [];
  hits.forEach((hit, rank) => {
    for (const raw of hit.doc.parsed.programmes.get(hit.sourceId) || []) {
      const hint = programmeHint(raw);
      const placeholder = isPlaceholderProgrammeTitle(hint.title);
      const validRange = Number.isFinite(Number(hint.start)) && Number.isFinite(Number(hint.stop));

      if (!validRange) {
        if (rank === 0) accepted.push({ raw, hint, placeholder, rank });
        continue;
      }

      const overlapping = accepted.filter((row) =>
        Number.isFinite(Number(row.hint.start))
        && Number.isFinite(Number(row.hint.stop))
        && rangesOverlap(hint.start, hint.stop, row.hint.start, row.hint.stop)
      );

      if (!overlapping.length) {
        accepted.push({ raw, hint, placeholder, rank });
        continue;
      }

      // A concrete programme from a secondary guide is allowed to replace
      // placeholder-only coverage ("Programa a definir", TBA, etc). Concrete
      // programmes never replace another concrete programme from the better
      // ranked guide, which avoids cross-guide duplicate schedules.
      if (!placeholder && overlapping.every((row) => row.placeholder)) {
        for (const row of overlapping) accepted.splice(accepted.indexOf(row), 1);
        accepted.push({ raw, hint, placeholder, rank });
      }
    }
  });

  accepted.sort((a, b) => {
    const as = Number.isFinite(Number(a.hint.start)) ? Number(a.hint.start) : Number.MAX_SAFE_INTEGER;
    const bs = Number.isFinite(Number(b.hint.start)) ? Number(b.hint.start) : Number.MAX_SAFE_INTEGER;
    return as - bs || a.rank - b.rank;
  });
  return accepted.map((row) => row.raw);
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
  const hitCandidates = new Map();
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
    const candidates = findHits(channel, docs);
    const hit = candidates[0] || null;
    if (hit) {
      hits.set(channel.id, hit);
      hitCandidates.set(channel.id, candidates);
    }
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
        ? {
          guideId: hit.doc.id,
          sourceId: hit.sourceId,
          match: hit.matchKind,
          futureProgrammes: hit.quality.futureProgrammes,
          realFutureProgrammes: hit.quality.realFutureProgrammes,
          placeholderFutureProgrammes: hit.quality.placeholderFutureProgrammes,
          horizonHours: Number((hit.quality.horizonMs / 3600000).toFixed(1)),
          dlhdScheduleFallbacks: linearEventCount,
        }
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
    const upstreamProgrammes = hit ? mergedProgrammesForHits(hitCandidates.get(channel.id) || [hit]) : [];
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
