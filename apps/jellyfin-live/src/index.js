import crypto from "node:crypto";
import zlib from "node:zlib";
import express from "express";
import { artworkContext, artworkPng } from "./artwork.js";
import { config, rawPlaylistUrl, withKey } from "./config.js";
import { discoverEpgShareUrls } from "./epg-sources.js";
import { filterJellyfinRows } from "./filter.js";
import { buildXmlTv, guideCoverage, matchGuideChannel } from "./guide.js";
import { organizeLineup } from "./lineup.js";
import {
  buildLineup,
  buildM3u,
  getCurrentCandidates,
  guideSourceUrlsForLineup,
  parseM3u,
  parseScheduleMetadata,
  parseXmlTv,
} from "./organizer.js";

const app = express();
const EPG_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.JELLYFIN_EPG_CONCURRENCY || 2)));
let cache = {
  at: 0,
  rawCount: 0,
  lineup: [],
  byId: new Map(),
  docs: [],
  epgSources: [],
  epgStats: {},
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
  let body = Buffer.from(await r.arrayBuffer());
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    body = zlib.gunzipSync(body);
  }
  return body.toString("utf8");
}

async function getJson(url, timeout = 30000) {
  const r = await fetch(url, {
    headers: { "user-agent": "JustOne Jellyfin Live", accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function safeJson(label, url) {
  try {
    const value = await getJson(url, 45000);
    return Array.isArray(value) ? value : [];
  } catch (e) {
    log("iptv-org fail", label, String(e.message || e));
    return [];
  }
}

async function loadIptvOrg() {
  if (!config.autoEpg) return { channels: [], logos: [], guides: [] };
  if (iptvCache.channels.length && Date.now() - iptvCache.at < 12 * 60 * 60 * 1000) return iptvCache;
  const [channels, logos, guides] = await Promise.all([
    safeJson("channels", "https://iptv-org.github.io/api/channels.json"),
    safeJson("logos", "https://iptv-org.github.io/api/logos.json"),
    safeJson("guides", "https://iptv-org.github.io/api/guides.json"),
  ]);
  iptvCache = { at: Date.now(), channels, logos, guides };
  log("iptv-org", `channels=${channels.length}`, `logos=${logos.length}`, `guides=${guides.length}`);
  return iptvCache;
}

async function loadXmlGuide(url) {
  const hit = xmlCache.get(url);
  if (hit && Date.now() - hit.at < Math.max(5, config.epgCacheMin) * 60 * 1000) return hit.doc;
  try {
    const body = await getText(url, 90000);
    if (!/<tv[\s>]/i.test(body)) throw new Error("not xmltv");
    const doc = parseXmlTv(body);
    if (!doc.channels.size) throw new Error("xmltv contained no channels");
    doc.sourceUrl = url;
    xmlCache.set(url, { at: Date.now(), doc });
    log("xmltv loaded", `channels=${doc.channels.size}`, url);
    return doc;
  } catch (e) {
    log("xmltv fail", url, String(e.message || e));
    return hit?.doc || null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return out;
}

function scheduleKey(name) {
  return String(name || "")
    .split(/\s+[—–]\s+/)[0]
    .toLowerCase()
    .replace(/\b(uhd|fhd|hd|4k|1080p|720p)\b/g, "")
    .replace(/[()\[\]]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gmtOffsetMinutes(ms) {
  const zone = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/i.exec(zone);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === "-" ? -mins : mins;
}

function respectScheduleTimezone(html, schedule) {
  if (!/Schedule Time UK GMT/i.test(html || "") || !schedule?.byEvent) return schedule;
  for (const row of schedule.byEvent.values()) {
    row.start += gmtOffsetMinutes(row.start) * 60 * 1000;
  }
  return schedule;
}

function keepScheduledEvents(rows, schedule) {
  return (rows || []).filter((ch) => {
    if (!/\s+[—–]\s+/.test(ch.name || "")) return true;
    return Boolean(schedule?.byEvent?.has(scheduleKey(ch.name)));
  });
}

function priorityDiagnostics(lineup, docs) {
  const out = {};
  for (const country of ["US", "GB", "PT"]) {
    const rows = (lineup || []).filter((ch) => ch.kind === "static" && String(ch.country || "").toUpperCase() === country);
    const unmatched = [];
    const matchedWithoutPrograms = [];
    let withPrograms = 0;
    for (const ch of rows) {
      const hit = matchGuideChannel(ch, docs);
      if (!hit) {
        unmatched.push({
          name: ch.name,
          tvgId: ch.tvgId,
          aliases: [...new Set((ch.candidates || []).map((x) => x?.label).filter(Boolean))].slice(0, 6),
        });
        continue;
      }
      const programs = hit.doc.programmes?.get(hit.id) || [];
      if (programs.length) {
        withPrograms += 1;
      } else {
        matchedWithoutPrograms.push({ name: ch.name, guideId: hit.id, score: hit.score });
      }
    }
    out[country] = {
      total: rows.length,
      withPrograms,
      unmatchedCount: unmatched.length,
      matchedWithoutProgramsCount: matchedWithoutPrograms.length,
      unmatched,
      matchedWithoutPrograms,
    };
  }
  return out;
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
    const filtered = filterJellyfinRows(raw);
    const schedule = scheduleHtml ? respectScheduleTimezone(scheduleHtml, parseScheduleMetadata(scheduleHtml)) : null;
    const safeRaw = keepScheduledEvents(filtered, schedule);
    const lineup = organizeLineup(buildLineup(safeRaw, { schedule, iptvOrg }));

    const manualUrls = [...new Set(config.epgSourceUrls)];
    const iptvUrls = config.autoEpg
      ? guideSourceUrlsForLineup(lineup, iptvOrg.guides, config.epgMaxSources)
      : [];
    const baseSources = [...new Set([...manualUrls, ...iptvUrls])];
    const fallbackBudget = Math.max(0, config.epgMaxSources - baseSources.length);
    const fallbackUrls = config.autoEpg && fallbackBudget
      ? await discoverEpgShareUrls(lineup, fallbackBudget).catch((e) => {
          log("epg fallback fail", String(e.message || e));
          return [];
        })
      : [];
    const epgSources = [...new Set([...baseSources, ...fallbackUrls])];
    const docs = (await mapLimit(epgSources, EPG_CONCURRENCY, loadXmlGuide)).filter(Boolean);
    const matchedChannels = lineup.filter((x) => x.kind === "static" && x.iptvOrgId).length;
    const coverage = guideCoverage(lineup, docs);
    const epgStats = {
      iptvChannels: iptvOrg.channels.length,
      iptvGuideRows: iptvOrg.guides.length,
      matchedChannels,
      manualSources: manualUrls.length,
      iptvSources: iptvUrls.length,
      fallbackSources: fallbackUrls.length,
      selectedSources: epgSources.length,
      loadedSources: docs.length,
      ...coverage,
    };

    cache = {
      at: Date.now(),
      rawCount: raw.length,
      lineup,
      byId: new Map(lineup.map((x) => [x.id, x])),
      docs,
      epgSources,
      epgStats,
      error: null,
    };
    const priorityCoverage = ["US", "GB", "PT"].map((country) => {
      const row = coverage.byCountry?.[country];
      return row ? `${country}:${row.channelsWithPrograms}/${row.staticChannels}(${row.coveragePercent}%)` : `${country}:0/0`;
    }).join(",");
    log(
      "refresh",
      `raw=${raw.length}`,
      `filtered=${filtered.length}`,
      `jellyfin=${lineup.length}`,
      `epg=${docs.length}/${epgSources.length}`,
      `matched=${coverage.channelsWithPrograms}/${coverage.staticChannels}`,
      `coverage=${coverage.coveragePercent}%`,
      `priority=${priorityCoverage}`,
      `iptv-guides=${iptvOrg.guides.length}`,
      `fallback=${fallbackUrls.length}`,
    );
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

app.get("/jellyfin/diagnostics", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      epg: state.epgStats,
      selectedSources: state.epgSources,
      priority: priorityDiagnostics(state.lineup, state.docs),
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/jellyfin/artwork/:variant/:token.png", (req, res) => {
  const variant = req.params.variant === "channel" ? "channel" : "program";
  const context = artworkContext(cache.lineup, req.params.token);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(artworkPng(req.params.token, variant, context));
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
    epgSources: state.docs.length,
    epgSelectedSources: state.epgSources.length,
    epgStats: state.epgStats,
  });
});

app.get("/jellyfin/health", (_req, res) => {
  res.json({
    service: "justone-jellyfin-live",
    ok: Boolean(cache.lineup.length) && !cache.error,
    lastRefresh: cache.at ? new Date(cache.at).toISOString() : null,
    rawChannels: cache.rawCount,
    channels: cache.lineup.length,
    epgSources: cache.docs.length,
    epgSelectedSources: cache.epgSources.length,
    epgStats: cache.epgStats,
    error: cache.error,
  });
});

const refreshMs = Math.max(1, config.refreshMin) * 60 * 1000;
setInterval(() => refresh(true).catch(() => {}), refreshMs).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  log(`JustOne Jellyfin Live on :${config.port}`);
  refresh(true).catch((e) => log("initial refresh", String(e.message || e)));
});
