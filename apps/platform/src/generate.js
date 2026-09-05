import fs from "node:fs/promises";
import path from "node:path";
import { config, withKey } from "./config.js";
import { signPlaybackUrl } from "./playbackSignature.js";
import { slugTvgId } from "./naming.js";
import { loadAllExtra } from "./sources.js";
import { withCountry } from "./country.js";

function log(...args) {
  process.stdout.write(args.map(String).join(" ") + "\n");
}

const state = {
  running: false,
  phase: "idle",
  channels: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  lastRefreshAt: null,
};

let channelCache = { at: 0, list: [] };
let refreshTimer = null;

function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(new RegExp("&" + "amp;", "g"), String.fromCharCode(38))
    .replace(new RegExp("&" + "lt;", "g"), String.fromCharCode(60))
    .replace(new RegExp("&" + "gt;", "g"), String.fromCharCode(62))
    .replace(new RegExp("&" + "quot;", "g"), String.fromCharCode(34))
    .trim();
}

function parseDlstreams247(html) {
  const seen = new Map();
  const re = /href="\/watch\.php\?id=(\d+)"[\s\S]{0,500}?card__title">([^<]+)/gi;
  let match;
  while ((match = re.exec(html))) {
    const id = match[1];
    if (!id || id === "00" || seen.has(id)) continue;
    const name = decodeHtml(match[2]);
    const group = /18\+|adult/i.test(name) ? "18+" : "24/7";
    seen.set(id, { ...withCountry({ id, name, group }), kind: "247" });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseSchedule(html) {
  const list = [];
  let group = "Live";
  let event = "";
  const re =
    /card__meta">([^<]+)<|schedule__eventTitle">([^<]+)<|href="\/watch\.php\?id=(\d+)"[^>]*title="([^"]*)"/gi;
  let match;
  while ((match = re.exec(html))) {
    if (match[1]) {
      group = decodeHtml(match[1]).slice(0, 60) || "Live";
      continue;
    }
    if (match[2]) {
      event = decodeHtml(match[2]);
      continue;
    }
    const id = match[3];
    if (!id || id === "00") continue;
    const channelName = decodeHtml(match[4] || `Channel ${id}`);
    list.push({
      id,
      name: event ? `${event} — ${channelName}` : channelName,
      group: forM3u(group) || "Sports",
      kind: "sports",
    });
  }
  return list;
}

const HTML_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html",
};

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: HTML_HEADERS,
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.text();
}

async function scrapeAll() {
  const [homeHtml, tvHtml] = await Promise.all([
    fetchHtml(config.dlstreamsHome),
    fetchHtml(config.dlstreams247),
  ]);
  const sports = parseSchedule(homeHtml);
  const tv = parseDlstreams247(tvHtml);
  log("scraped schedule", sports.length, "streams;", "24/7", tv.length, "channels");
  const list = [...sports, ...tv];
  if (!list.length) throw new Error("dlstreams parse empty");
  return list;
}

export async function loadChannels(force = false) {
  const stale = Date.now() - channelCache.at > config.liveRefreshMin * 60 * 1000;
  if (!force && channelCache.list.length && !stale) return channelCache.list;

  let list = [];
  try {
    list = await scrapeAll();
    const extra = await loadAllExtra();
    log("extra m3u", extra.length);
    list = [...list, ...extra.map((channel) => ({ ...channel, kind: channel.kind || "ext" }))];
    list = list.map((channel) =>
      channel.kind === "247" ? withCountry({ ...channel, kind: "247" }) : channel,
    );
    list.sort((a, b) => {
      const kind = String(a.kind || "").localeCompare(String(b.kind || ""));
      const group = String(a.group || "").localeCompare(String(b.group || ""));
      return kind || group || String(a.name || "").localeCompare(String(b.name || ""));
    });
  } catch (error) {
    log("dlstreams scrape failed, fallback dlhd", String(error.message || error));
    const response = await fetch(`${config.dlhdUrl}/api/channels`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`dlhd channels ${response.status}`);
    const data = await response.json();
    list = Array.isArray(data) ? data : data.channels || data.items || [];
  }

  channelCache = { at: Date.now(), list };
  state.channels = list.length;
  state.lastRefreshAt = Date.now();
  return list;
}

function forM3u(value) {
  return String(value || "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/["\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function filterChannels(list, kind) {
  if (!kind || kind === "all") return list;
  const normalized = String(kind).toLowerCase();
  if (normalized === "247" || normalized === "tv") return list.filter((c) => c.kind === "247");
  if (normalized === "sports") return list.filter((c) => c.kind === "sports");
  if (normalized === "extra") return list.filter((c) => c.kind === "ext");
  return list.filter((c) => String(c.group || "").toLowerCase() === normalized);
}

export function buildM3u(list, kind = "all") {
  const rows = filterChannels(list, kind);
  const lines = [`#EXTM3U url-tvg="${config.epgUrl}" tvg-shift=0`];
  const base = kind === "sports" ? 5000 : kind === "extra" ? 8000 : kind === "247" ? 1000 : 1;

  rows.forEach((channel, index) => {
    const name = forM3u(channel.name || `Channel ${channel.id}`);
    const tvg = channel.kind === "ext" ? slugTvgId(name) || channel.id : `dlhd-${channel.id}`;
    const logo = channel.logo || channel.image || "";
    const group = forM3u(channel.group || channel.category || "Live") || "Live";
    const number = base + index;
    lines.push(
      `#EXTINF:-1 tvg-id="${tvg}" tvg-name="${name}" tvg-logo="${logo}" tvg-chno="${number}" group-title="${group}",${name}`,
    );
    const play = channel.kind === "ext" ? `/play/ext/${channel.id}` : `/play/live/${channel.id}.ts`;
    const url = config.playbackUrl + play;
    lines.push(channel.kind === "ext" ? withKey(url) : signPlaybackUrl(url));
  });

  return lines.join("\n") + "\n";
}

export async function writeLivePlaylist(force = true) {
  if (state.running) return { file: path.join(config.liveDir, "playlist.m3u8"), count: state.channels };

  state.running = true;
  state.phase = "refresh";
  state.error = null;
  state.startedAt = Date.now();
  state.finishedAt = null;

  try {
    const list = await loadChannels(force);
    await fs.mkdir(config.liveDir, { recursive: true });
    const files = [];
    for (const kind of ["all", "247", "sports", "extra"]) {
      const name = kind === "all" ? "playlist.m3u8" : `${kind}.m3u8`;
      const file = path.join(config.liveDir, name);
      await fs.writeFile(file, buildM3u(list, kind), "utf8");
      files.push(file);
    }
    state.phase = "done";
    state.channels = list.length;
    state.lastRefreshAt = Date.now();
    return { file: files[0], count: list.length, files };
  } catch (error) {
    state.phase = "error";
    state.error = String(error?.message || error);
    throw error;
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
}

export async function bootstrap() {
  log("bootstrap live start");
  try {
    const live = await writeLivePlaylist(true);
    log("bootstrap live m3u", live.count, live.file);
  } catch (error) {
    log("bootstrap live failed", String(error?.message || error));
  }
}

export function startLiveRefresh() {
  if (refreshTimer) return;
  const intervalMs = config.liveRefreshMin * 60 * 1000;
  refreshTimer = setInterval(() => {
    writeLivePlaylist(true)
      .then((out) => log("scheduled live", out.count))
      .catch((error) => log("scheduled live fail", String(error?.message || error)));
  }, intervalMs);
  refreshTimer.unref?.();
  log(`live refresh every ${config.liveRefreshMin}m`);
}

export function liveStatus() {
  return {
    ...state,
    path: config.liveDir,
    refreshMin: config.liveRefreshMin,
    cacheAgeMs: channelCache.at ? Date.now() - channelCache.at : null,
  };
}
