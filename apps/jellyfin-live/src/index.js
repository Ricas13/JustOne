import crypto from "node:crypto";
import zlib from "node:zlib";
import express from "express";

import { artworkContext, artworkPng } from "./artwork.js";
import { config, rawPlaylistUrl, withKey } from "./config.js";
import { countryGuideReserve, discoverEpgShareUrls } from "./epg-sources.js";
import { filterJellyfinRows } from "./filter.js";
import { buildXmlTv, guideCoverage } from "./guide.js";
import {
  iptvOrgFetchComplete,
  iptvOrgSnapshotReady,
  mergeIptvOrgSnapshot,
} from "./iptv-org-cache.js";
import { organizeLineup } from "./lineup.js";
import { applyEpgIdentityLogos } from "./logo-bridge.js";
import {
  buildLineup,
  buildM3u,
  getCurrentCandidates,
  guideSourceUrlsForLineup,
  parseM3u,
  parseScheduleMetadata,
  parseXmlTv,
} from "./organizer.js";
import { streamSequentially } from "./play.js";

const app = express();
const EPG_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.JELLYFIN_EPG_CONCURRENCY || 2)));
const IPTV_ORG_CACHE_MS = 12 * 60 * 60 * 1000;
const IPTV_ORG_RETRY_MS = Math.max(60_000, Number(process.env.JELLYFIN_IPTV_ORG_RETRY_MS || 300_000));

let cache = {
  at: 0,
  rawCount: 0,
  lineup: [],
  docs: [],
  epgSources: [],
  epgStats: {},
  error: null,
};
let iptvCache = {
  at: 0,
  retryAt: 0,
  channels: [],
  logos: [],
  guides: [],
  reused: [],
  missing: [],
};
const xmlCache = new Map();

function log(...values) {
  process.stdout.write(`${values.map(String).join(" ")}\n`);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorised(req) {
  if (!config.playlistKey) return true;
  return safeEqual(req.query.key || req.headers["x-playlist-key"] || "", config.playlistKey);
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("x-justone", "minimal-dlhd");
  if (req.path === "/jellyfin/health") return next();
  if (!req.path.startsWith("/jellyfin/")) return res.status(404).end();
  if (!authorised(req)) return res.status(401).json({ error: "key required" });
  next();
});

async function getText(url, timeout = 30_000) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 JustOne", accept: "*/*" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  let body = Buffer.from(await response.arrayBuffer());
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
  return body.toString("utf8");
}

async function getJson(url, timeout = 30_000) {
  const response = await fetch(url, {
    headers: { "user-agent": "JustOne", accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function safeJson(label, url) {
  try {
    const value = await getJson(url, 45_000);
    if (!Array.isArray(value) || !value.length) throw new Error("empty or invalid JSON array");
    return value;
  } catch (error) {
    log("iptv-org fail", label, String(error.message || error));
    return null;
  }
}

async function loadIptvOrg(force = false) {
  if (!config.autoEpg) return { channels: [], logos: [], guides: [], reused: [], missing: [] };

  const now = Date.now();
  if (!force && iptvCache.retryAt && now < iptvCache.retryAt) return iptvCache;
  if (!force && !iptvCache.retryAt && iptvOrgSnapshotReady(iptvCache) && now - iptvCache.at < IPTV_ORG_CACHE_MS) {
    return iptvCache;
  }

  const [channels, logos, guides] = await Promise.all([
    safeJson("channels", "https://iptv-org.github.io/api/channels.json"),
    safeJson("logos", "https://iptv-org.github.io/api/logos.json"),
    safeJson("guides", "https://iptv-org.github.io/api/guides.json"),
  ]);
  const fetched = { channels, logos, guides };
  const merged = mergeIptvOrgSnapshot(iptvCache, fetched);
  const complete = iptvOrgFetchComplete(fetched);
  const ready = iptvOrgSnapshotReady(merged.next);

  iptvCache = {
    at: complete ? now : (iptvCache.at || (ready ? now : 0)),
    retryAt: complete ? 0 : now + IPTV_ORG_RETRY_MS,
    ...merged.next,
    reused: merged.reused,
    missing: merged.missing,
  };
  return iptvCache;
}

async function loadXmlGuide(url) {
  const hit = xmlCache.get(url);
  if (hit && Date.now() - hit.at < Math.max(5, config.epgCacheMin) * 60_000) return hit.doc;
  try {
    const body = await getText(url, 90_000);
    if (!/<tv[\s>]/i.test(body)) throw new Error("not XMLTV");
    const doc = parseXmlTv(body);
    if (!doc.channels.size) throw new Error("XMLTV contained no channels");
    doc.sourceUrl = url;
    xmlCache.set(url, { at: Date.now(), doc });
    return doc;
  } catch (error) {
    log("xmltv fail", url, String(error.message || error));
    return hit?.doc || null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return out;
}

async function refresh(force = false) {
  const stale = Date.now() - cache.at > Math.max(1, config.refreshMin) * 60_000;
  if (!force && cache.lineup.length && !stale) return cache;

  try {
    const [playlistBody, iptvOrg, scheduleHtml] = await Promise.all([
      getText(rawPlaylistUrl(), 30_000),
      loadIptvOrg(force),
      getText(config.dlstreamsHome, 30_000).catch(() => ""),
    ]);

    const raw = parseM3u(playlistBody);
    const filtered = filterJellyfinRows(raw);
    const schedule = scheduleHtml ? parseScheduleMetadata(scheduleHtml) : null;

    // buildLineup is the only merge point: duplicate provider rows become one
    // logical Jellyfin channel and retain their original URLs as ordered sources.
    const lineup = organizeLineup(buildLineup(filtered, { schedule, iptvOrg }));

    const manualUrls = [...new Set(config.epgSourceUrls)];
    const countryReserve = config.autoEpg
      ? countryGuideReserve(lineup, config.epgMaxSources, manualUrls.length)
      : 0;
    const discoveredCountryUrls = config.autoEpg && countryReserve
      ? await discoverEpgShareUrls(lineup, countryReserve).catch((error) => {
          log("epg country fail", String(error.message || error));
          return [];
        })
      : [];
    const countryUrls = discoveredCountryUrls.filter((url) => !manualUrls.includes(url));
    const baseSources = [...new Set([...manualUrls, ...countryUrls])];
    const iptvBudget = Math.max(0, config.epgMaxSources - baseSources.length);
    const iptvUrls = config.autoEpg
      ? guideSourceUrlsForLineup(lineup, iptvOrg.guides, iptvBudget)
      : [];
    const epgSources = [...new Set([...baseSources, ...iptvUrls])].slice(0, Math.max(0, config.epgMaxSources));
    const docs = (await mapLimit(epgSources, EPG_CONCURRENCY, loadXmlGuide)).filter(Boolean);

    const coverage = guideCoverage(lineup, docs);
    const identityLogos = applyEpgIdentityLogos(lineup, docs, iptvOrg);
    const epgStats = {
      ...coverage,
      identityLogosApplied: identityLogos.applied,
      selectedSources: epgSources.length,
      loadedSources: docs.length,
      countrySources: countryUrls.length,
      iptvSources: iptvUrls.length,
    };

    cache = {
      at: Date.now(),
      rawCount: raw.length,
      lineup,
      docs,
      epgSources,
      epgStats,
      error: null,
    };

    log(
      "refresh",
      `raw=${raw.length}`,
      `filtered=${filtered.length}`,
      `merged=${lineup.length}`,
      `epg=${docs.length}/${epgSources.length}`,
      `coverage=${coverage.coveragePercent}%`,
      "playback=sequential-ffmpeg",
    );
  } catch (error) {
    cache.error = String(error.message || error);
    log("refresh fail", cache.error);
    if (!cache.lineup.length) throw error;
  }
  return cache;
}

app.get("/jellyfin/playlist.m3u8", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buildM3u(state.lineup));
  } catch (error) {
    res.status(502).send(String(error.message || error));
  }
});

app.get("/jellyfin/play/:token.ts", async (req, res) => {
  try {
    const state = await refresh(false);
    const id = String(req.params.token || "");
    const channel = state.lineup.find((row) => row.id === id);
    if (!channel) return res.status(404).json({ error: "channel not found" });

    const candidates = getCurrentCandidates(channel);
    return streamSequentially(req, res, { ...channel, candidates }, {
      log: (message) => log("play", channel.name, message),
    });
  } catch (error) {
    if (!res.headersSent) return res.status(502).json({ error: String(error.message || error) });
    res.end();
  }
});

app.get("/jellyfin/guide.xml", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buildXmlTv(state.lineup, state.docs));
  } catch (error) {
    res.status(502).send(String(error.message || error));
  }
});

app.get("/jellyfin/artwork/:variant/:token.png", (req, res) => {
  const variant = req.params.variant === "channel" ? "channel" : "program";
  const context = artworkContext(cache.lineup, req.params.token);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(artworkPng(req.params.token, variant, context));
});

app.get("/jellyfin/diagnostics", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      playback: "sequential-ffmpeg",
      rawChannels: state.rawCount,
      mergedChannels: state.lineup.length,
      channels: state.lineup.map((channel) => ({
        id: channel.id,
        name: channel.name,
        sources: getCurrentCandidates(channel).length,
      })),
      epg: state.epgStats,
      epgSources: state.epgSources,
    });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/jellyfin/links", async (_req, res) => {
  const state = await refresh(false).catch(() => cache);
  res.json({
    playlist: withKey(`${config.publicUrl}/jellyfin/playlist.m3u8`),
    guide: withKey(`${config.publicUrl}/jellyfin/guide.xml`),
    playback: "sequential-ffmpeg",
    rawChannels: state.rawCount,
    channels: state.lineup.length,
  });
});

app.get("/jellyfin/health", (_req, res) => {
  res.json({
    service: "justone-jellyfin-live",
    ok: Boolean(cache.lineup.length) && !cache.error,
    playback: "sequential-ffmpeg",
    lastRefresh: cache.at ? new Date(cache.at).toISOString() : null,
    rawChannels: cache.rawCount,
    channels: cache.lineup.length,
    error: cache.error,
  });
});

const refreshMs = Math.max(1, config.refreshMin) * 60_000;
setInterval(() => refresh(false).catch(() => {}), refreshMs).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  log(`JustOne Jellyfin Live on :${config.port}`);
  refresh(true).catch((error) => log("initial refresh", String(error.message || error)));
});
