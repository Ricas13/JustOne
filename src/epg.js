import { normalize, stripTags, text, xmlDecode, xmlEscape } from "./util.js";

export function parseXmlTv(body) {
  const source = String(body || "");
  const channels = new Map();
  const names = new Map();
  const programmes = new Map();
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

  return { channels, names, programmes };
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

function remapProgramme(programme, tvgId) {
  return programme.replace(/\bchannel=(?:"[^"]+"|'[^']+')/i, `channel="${xmlEscape(tvgId)}"`);
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
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

export function enrichAndBuildGuide(channels, docs, overrides = {}) {
  const hits = new Map();
  for (const channel of channels) {
    const hit = findHit(channel, docs);
    if (hit) hits.set(channel.id, hit);
    const override = overrides[channel.id] || overrides[channel.key] || {};
    if (override.logo) channel.logo = override.logo;
    else if (hit?.meta?.icon) channel.logo = hit.meta.icon;
    if (!channel.logo) channel.logo = channel.variants.find((v) => v.logo)?.logo || "";
    channel.epg = channel.referenceKind === "event"
      ? { generated: "dlhd-schedule" }
      : (hit ? { guideId: hit.doc.id, sourceId: hit.sourceId } : null);
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
    if (!hit) continue;
    for (const programme of hit.doc.parsed.programmes.get(hit.sourceId) || []) {
      out.push(remapProgramme(programme, channel.tvgId));
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
