import { attr, text } from "./util.js";

export function parseM3u(body) {
  const lines = String(body || "").split(/\r?\n/);
  const rows = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      meta = {
        name: text(line.slice(line.indexOf(",") + 1)),
        tvgId: attr(line, "tvg-id"),
        tvgName: attr(line, "tvg-name"),
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title") || "Live TV",
        channelNumber: Number(attr(line, "tvg-chno")) || null,
      };
      continue;
    }
    if (meta && /^(https?|rtsp|rtmp):\/\//i.test(line)) {
      rows.push({ ...meta, url: line });
      meta = null;
    }
  }
  return rows;
}

function q(value) {
  return String(value ?? "").replace(/["\r\n]/g, " ").trim();
}

export function buildM3u(snapshot, { sourceId = null, publicGuideUrl = "" } = {}) {
  const header = publicGuideUrl
    ? `#EXTM3U url-tvg="${q(publicGuideUrl)}" x-tvg-url="${q(publicGuideUrl)}"`
    : "#EXTM3U";
  const lines = [header];
  for (const channel of snapshot.channels || []) {
    const variants = (channel.variants || []).filter((v) => !sourceId || v.sourceId === sourceId);
    for (const variant of variants) {
      const rank = String(variant.order + 1).padStart(3, "0");
      const label = `${channel.name} [JO:${rank}] [${variant.quality}]${variant.backup ? " [BACKUP]" : ""}`;
      lines.push(
        `#EXTINF:-1 tvg-id="${q(channel.tvgId)}" tvg-name="${q(channel.name)}" tvg-logo="${q(channel.logo)}" tvg-chno="${q(channel.number)}" group-title="${q(channel.group)}",${q(label)}`
      );
      lines.push(variant.url);
    }
  }
  return `${lines.join("\n")}\n`;
}
