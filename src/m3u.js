import { attr, text } from "./util.js";

function extinfMeta(line) {
  return {
    name: text(line.slice(line.indexOf(",") + 1)),
    tvgId: attr(line, "tvg-id"),
    tvgName: attr(line, "tvg-name"),
    logo: attr(line, "tvg-logo"),
    group: attr(line, "group-title") || "Live TV",
    channelNumber: Number(attr(line, "tvg-chno")) || null,
  };
}

function consumeLine(raw, state) {
  const line = String(raw || "").trim();
  if (line.startsWith("#EXTINF:")) {
    state.meta = extinfMeta(line);
    return null;
  }
  if (state.meta && /^(https?|rtsp|rtmp):\/\//i.test(line)) {
    const row = { ...state.meta, url: line };
    state.meta = null;
    return row;
  }
  return null;
}

export function parseM3u(body) {
  const rows = [];
  const state = { meta: null };
  for (const raw of String(body || "").split(/\r?\n/)) {
    const row = consumeLine(raw, state);
    if (row) rows.push(row);
  }
  return rows;
}

// Incremental parser for very large provider playlists. The full M3U is never
// materialised as one string or split into a giant array. Only the current line
// and the current EXTINF metadata are retained while bytes arrive.
export async function parseM3uStream(readable, {
  onRow,
  onProgress,
  progressIntervalBytes = 25 * 1024 * 1024,
  maxLineLength = 4 * 1024 * 1024,
} = {}) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== "function") {
    throw new Error("M3U response body is not streamable");
  }
  const decoder = new TextDecoder("utf-8");
  const state = { meta: null };
  let carry = "";
  let rows = 0;
  let bytes = 0;
  let lastProgressBytes = 0;

  async function handle(raw) {
    const row = consumeLine(raw.replace(/\r$/, ""), state);
    if (!row) return;
    rows += 1;
    if (onRow) await onRow(row);
  }

  async function progress(force = false) {
    if (!onProgress) return;
    if (!force && bytes - lastProgressBytes < progressIntervalBytes) return;
    lastProgressBytes = bytes;
    await onProgress({ rows, bytes });
  }

  for await (const chunk of readable) {
    bytes += chunk?.byteLength ?? chunk?.length ?? 0;
    carry += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      if (line.length > maxLineLength) throw new Error(`M3U line exceeds ${maxLineLength} characters`);
      await handle(line);
    }
    if (carry.length > maxLineLength) throw new Error(`M3U line exceeds ${maxLineLength} characters`);
    await progress(false);
  }

  carry += decoder.decode();
  if (carry) await handle(carry);
  await progress(true);
  return { rows, bytes };
}

function q(value) {
  return String(value ?? "").replace(/["\r\n]/g, " ").trim();
}

export function buildM3u(snapshot, { sourceId = null, guideUrl = "", publicGuideUrl = "" } = {}) {
  const xmltv = guideUrl || publicGuideUrl;
  const header = xmltv
    ? `#EXTM3U url-tvg="${q(xmltv)}" x-tvg-url="${q(xmltv)}"`
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
