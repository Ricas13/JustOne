import crypto from "node:crypto";
import express from "express";
import { config, rawPlaylistUrl, withKey } from "./config.js";
import {
  artworkPng,
  buildLineup,
  buildM3u,
  buildXmlTv,
  getCurrentCandidates,
  guideSourceUrlsForLineup,
  parseM3u,
  parseScheduleMetadata,
  parseXmlTv,
} from "./organizer.js";

const app = express();
let cache = {
  at: 0,
  rawCount: 0,
  lineup: [],
  byId: new Map(),
  docs: [],
  epgSources: [],
  error: null,
};
let iptvCache = { at: 0, channels: [], logos: [], guides: [] };
let xmlCache = new Map();

function log(...a) {
  process.stdout.write(a.map(String).join(" ") + "\n");
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
  res.setHeader("x-justone", "jellyfin-live");
  if (req.path === "/jellyfin/health") return next();
  if (!req.path.startsWith("/jellyfin/")) return res.status(404).end();
  if (!authorised(req)) return res.status(401).json({ error: "key required" });
  next();
});

async function getText(url, timeout = 30000) {
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 JustOne Jellyfin Live", accept: "*/*" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.text();
}

async function getJson(url, timeout = 30000) {
  const r = await fetch(url, {
    headers: { "user-agent": "JustOne Jellyfin Live", accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function loadIptvOrg() {
  if (!config.autoEpg) return { channels: [], logos: [], guides: [] };
  if (iptvCache.channels.length && Date.now() - iptvCache.at < 12 * 60 * 60 * 1000) return iptvCache;
  const [channels, logos, guides] = await Promise.all([
    getJson("https://iptv-org.github.io/api/channels.json").catch(() => []),
    getJson("https://iptv-org.github.io/api/logos.json").catch(() => []),
    getJson("https://iptv-org.github.io/api/guides.json").catch(() => []),
  ]);
  iptvCache = { at: Date.now(), channels, logos, guides };
  return iptvCache;
}

async function loadXmlGuide(url) {
  const hit = xmlCache.get(url);
  if (hit && Date.now() - hit.at < Math.max(5, config.epgCacheMin) * 60 * 1000) return hit.doc;
  try {
    const body = await getText(url, 45000);
    if (!/<tv[\s>]/i.test(body)) throw new Error("not xmltv");
    const doc = parseXmlTv(body);
    xmlCache.set(url, { at: Date.now(), doc });
    return doc;
  } catch (e) {
    log("xmltv fail", url, String(e.message || e));
    return hit?.doc || null;
  }
}

async function refresh(force = false) {
  const stale = Date.now() - cache.at > Math.max(1, config.refreshMin) * 60 * 1000;
  if (!force && cache.lineup.length && !stale) return cache;
  try {
    const [playlistBody, scheduleHtml, iptvOrg] = await Promise.all([
      getText(rawPlaylistUrl(true)),
      getText(config.dlstreamsHome).catch(() => ""),
      loadIptvOrg(),
    ]);
    const raw = parseM3u(playlistBody);
    const schedule = scheduleHtml ? parseScheduleMetadata(scheduleHtml) : null;
    const lineup = buildLineup(raw, { schedule, iptvOrg });
    const autoUrls = config.autoEpg ? guideSourceUrlsForLineup(lineup, iptvOrg.guides, config.epgMaxSources) : [];
    const epgSources = [...new Set([...config.epgSourceUrls, ...autoUrls])];
    const docs = (await Promise.all(epgSources.map(loadXmlGuide))).filter(Boolean);
    cache = {
      at: Date.now(),
      rawCount: raw.length,
      lineup,
      byId: new Map(lineup.map((x) => [x.id, x])),
      docs,
      epgSources,
      error: null,
    };
    log("refresh", `raw=${raw.length}`, `jellyfin=${lineup.length}`, `epg=${docs.length}`);
  } catch (e) {
    cache.error = String(e.message || e);
    log("refresh fail", cache.error);
    if (!cache.lineup.length) throw e;
  }
  return cache;
}

async function probe(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "Jellyfin/JustOne" },
      signal: AbortSignal.timeout(6000),
    });
    return r.status >= 200 && r.status < 400;
  } catch {
    return false;
  }
}

app.get("/jellyfin/playlist.m3u8", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buildM3u(state.lineup));
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/jellyfin/guide.xml", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buildXmlTv(state.lineup, state.docs));
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/jellyfin/artwork/:variant/:token.png", (req, res) => {
  const variant = req.params.variant === "channel" ? "channel" : "program";
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(artworkPng(req.params.token, variant));
});

app.get("/jellyfin/play/:id", async (req, res) => {
  try {
    let state = await refresh(false);
    let channel = state.byId.get(String(req.params.id).replace(/\.ts$/i, ""));
    if (!channel) {
      state = await refresh(true);
      channel = state.byId.get(String(req.params.id).replace(/\.ts$/i, ""));
    }
    if (!channel) return res.status(404).json({ error: "channel not found" });
    const candidates = getCurrentCandidates(channel);
    if (!candidates.length) return res.status(404).json({ error: "no active source" });
    let selected = candidates[0];
    for (const candidate of candidates.slice(0, 4)) {
      if (await probe(candidate.url)) {
        selected = candidate;
        break;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("x-justone-source", selected.label || "");
    return res.redirect(302, selected.url);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
});

app.get("/jellyfin/links", async (_req, res) => {
  const state = await refresh(false).catch(() => cache);
  res.json({
    playlist: withKey(`${config.publicUrl}/jellyfin/playlist.m3u8`),
    guide: withKey(`${config.publicUrl}/jellyfin/guide.xml`),
    channels: state.lineup.length,
    rawChannels: state.rawCount,
    epgSources: state.epgSources.length,
  });
});

app.get("/jellyfin/health", (_req, res) => {
  res.json({
    service: "justone-jellyfin-live",
    ok: Boolean(cache.lineup.length) && !cache.error,
    lastRefresh: cache.at ? new Date(cache.at).toISOString() : null,
    rawChannels: cache.rawCount,
    channels: cache.lineup.length,
    epgSources: cache.epgSources.length,
    error: cache.error,
  });
});

const refreshMs = Math.max(1, config.refreshMin) * 60 * 1000;
setInterval(() => refresh(true).catch(() => {}), refreshMs).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  log(`JustOne Jellyfin Live on :${config.port}`);
  refresh(true).catch((e) => log("initial refresh", String(e.message || e)));
});
