import crypto from "node:crypto";
import zlib from "node:zlib";
import express from "express";
import { artworkContext, artworkPng } from "./artwork.js";
import { config, rawPlaylistUrl, withKey } from "./config.js";
import { countryGuideReserve, discoverEpgShareUrls } from "./epg-sources.js";
import { applyEventSchedule } from "./event-schedule.js";
import { collapseSportsEvents, selectWorkingEventCandidate } from "./event-failover.js";
import { filterJellyfinRows } from "./filter.js";
import { buildXmlTv, guideCoverage, matchGuideChannel } from "./guide.js";
import { organizeLineup } from "./lineup.js";
import { applyEpgIdentityLogos } from "./logo-bridge.js";
import { buildMetadataLineup, buildMetadataM3u } from "./metadata-only.js";
import {
  iptvOrgFetchComplete,
  iptvOrgSnapshotReady,
  mergeIptvOrgSnapshot,
} from "./iptv-org-cache.js";
import {
  guideSourceUrlsForLineup,
  parseM3u,
  parseScheduleMetadata,
  parseXmlTv,
} from "./organizer.js";

const app = express();
const EPG_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.JELLYFIN_EPG_CONCURRENCY || 2)),
);
const IPTV_ORG_CACHE_MS = 12 * 60 * 60 * 1000;
const IPTV_ORG_RETRY_MS = Math.max(
  60 * 1000,
  Number(process.env.JELLYFIN_IPTV_ORG_RETRY_MS || 5 * 60 * 1000),
);

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
let xmlCache = new Map();

function log(...values) {
  process.stdout.write(values.map(String).join(" ") + "\n");
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
  res.setHeader("x-justone", "jellyfin-live-metadata");
  if (req.path === "/jellyfin/health") return next();
  if (!req.path.startsWith("/jellyfin/")) return res.status(404).end();
  if (!authorised(req)) return res.status(401).json({ error: "key required" });
  next();
});

async function getText(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 JustOne Jellyfin Live", accept: "*/*" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);

  let body = Buffer.from(await response.arrayBuffer());
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    body = zlib.gunzipSync(body);
  }
  return body.toString("utf8");
}

async function getJson(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { "user-agent": "JustOne Jellyfin Live", accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function safeJson(label, url) {
  try {
    const value = await getJson(url, 45000);
    if (!Array.isArray(value) || !value.length) {
      throw new Error("empty or invalid JSON array");
    }
    return value;
  } catch (error) {
    log("iptv-org fail", label, String(error.message || error));
    return null;
  }
}

async function loadIptvOrg(force = false) {
  if (!config.autoEpg) {
    return { channels: [], logos: [], guides: [], reused: [], missing: [] };
  }

  const now = Date.now();
  if (!force && iptvCache.retryAt && now < iptvCache.retryAt) return iptvCache;
  if (
    !force
    && !iptvCache.retryAt
    && iptvOrgSnapshotReady(iptvCache)
    && now - iptvCache.at < IPTV_ORG_CACHE_MS
  ) {
    return iptvCache;
  }

  const [channels, logos, guides] = await Promise.all([
    safeJson("channels", "https://iptv-org.github.io/api/channels.json"),
    safeJson("logos", "https://iptv-org.github.io/api/logos.json"),
    safeJson("guides", "https://iptv-org.github.io/api/guides.json"),
  ]);

  const fetched = { channels, logos, guides };
  const merged = mergeIptvOrgSnapshot(iptvCache, fetched);
  const completeFetch = iptvOrgFetchComplete(fetched);
  const ready = iptvOrgSnapshotReady(merged.next);

  iptvCache = {
    at: completeFetch ? now : (iptvCache.at || (ready ? now : 0)),
    retryAt: completeFetch ? 0 : now + IPTV_ORG_RETRY_MS,
    ...merged.next,
    reused: merged.reused,
    missing: merged.missing,
  };

  log(
    "iptv-org",
    `channels=${iptvCache.channels.length}`,
    `logos=${iptvCache.logos.length}`,
    `guides=${iptvCache.guides.length}`,
    `reused=${iptvCache.reused.join(",") || "none"}`,
    `missing=${iptvCache.missing.join(",") || "none"}`,
    completeFetch ? "state=fresh" : `state=degraded retry=${Math.round(IPTV_ORG_RETRY_MS / 1000)}s`,
  );
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
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker),
  );
  return out;
}

function priorityDiagnostics(lineup, docs) {
  const out = {};
  for (const country of ["US", "GB", "PT"]) {
    const rows = (lineup || []).filter(
      (ch) => ch.kind === "static" && String(ch.country || "").toUpperCase() === country,
    );
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
      if (programs.length) withPrograms += 1;
      else matchedWithoutPrograms.push({ name: ch.name, guideId: hit.id, score: hit.score });
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
    // The raw platform playlist remains the sole playback owner. Refresh only
    // decorates metadata and groups duplicate sports events; it never probes or
    // resolves streams. Duplicate-event probing happens only when that one
    // selector URL is opened, and the selector redirects to the untouched raw
    // /play/live/... URL that wins.
    const [playlistBody, iptvOrg, scheduleHtml] = await Promise.all([
      getText(rawPlaylistUrl(true)),
      loadIptvOrg(force),
      getText(config.dlstreamsHome, 30000).catch((error) => {
        log("event schedule fail", String(error.message || error));
        return "";
      }),
    ]);
    const raw = parseM3u(playlistBody);
    const filtered = filterJellyfinRows(raw);
    const schedule = scheduleHtml ? parseScheduleMetadata(scheduleHtml) : null;
    const scheduled = applyEventSchedule(
      buildMetadataLineup(filtered, {
        iptvOrg,
        excludeAdult: config.excludeAdult,
      }),
      schedule,
    );
    const lineup = collapseSportsEvents(
      organizeLineup(scheduled.lineup),
    );

    // Country packs are the primary EPG source for country-grouped television.
    // Reserve one slot per represented country first, then use the remaining
    // budget for IPTV-org guide URLs. A failed country-pack discovery simply
    // hands the unused capacity back to IPTV-org instead of reducing coverage.
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
    const countryBaseSources = [...new Set([...manualUrls, ...countryUrls])];
    const iptvBudget = Math.max(0, config.epgMaxSources - countryBaseSources.length);
    const iptvUrls = config.autoEpg
      ? guideSourceUrlsForLineup(lineup, iptvOrg.guides, iptvBudget)
      : [];
    const epgSources = [...new Set([...countryBaseSources, ...iptvUrls])]
      .slice(0, Math.max(0, config.epgMaxSources));
    const docs = (await mapLimit(epgSources, EPG_CONCURRENCY, loadXmlGuide)).filter(Boolean);

    const matchedChannels = lineup.filter((ch) => ch.iptvOrgId).length;
    const coverage = guideCoverage(lineup, docs);
    const identityLogos = applyEpgIdentityLogos(lineup, docs, iptvOrg);
    const generatedLogosRemaining = Math.max(
      0,
      coverage.generatedLogosRemaining - identityLogos.applied,
    );
    const realLogosTotal =
      coverage.existingLogosKept + coverage.guideLogosApplied + identityLogos.applied;
    const epgStats = {
      iptvChannels: iptvOrg.channels.length,
      iptvLogos: iptvOrg.logos.length,
      iptvGuideRows: iptvOrg.guides.length,
      iptvMetadataReused: iptvOrg.reused || [],
      iptvMetadataMissing: iptvOrg.missing || [],
      matchedChannels,
      manualSources: manualUrls.length,
      countryReserve,
      countrySources: countryUrls.length,
      iptvSources: iptvUrls.length,
      fallbackSources: countryUrls.length,
      selectedSources: epgSources.length,
      loadedSources: docs.length,
      eventScheduleDate: schedule
        ? `${schedule.year}-${String(schedule.month).padStart(2, "0")}-${String(schedule.day).padStart(2, "0")}`
        : null,
      eventScheduleRows: scheduled.eventRows,
      eventScheduleMatched: scheduled.matched,
      eventScheduleUnmatched: scheduled.unmatched,
      ...coverage,
      iptvIdentityLogosApplied: identityLogos.applied,
      iptvIdentityLogoCandidates: identityLogos.candidates,
      generatedLogosRemaining,
      realLogosTotal,
      failoverEvents: lineup.filter((ch) => ch.eventFailover).length,
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

    const priorityCoverage = ["US", "GB", "PT"]
      .map((country) => {
        const row = coverage.byCountry?.[country];
        return row
          ? `${country}:${row.channelsWithPrograms}/${row.staticChannels}(${row.coveragePercent}%)`
          : `${country}:0/0`;
      })
      .join(",");

    log(
      "refresh",
      `raw=${raw.length}`,
      `filtered=${filtered.length}`,
      `jellyfin=${lineup.length}`,
      "playback=raw-grok-urls",
      `failover-events=${epgStats.failoverEvents}`,
      `event-times=${scheduled.matched}/${scheduled.eventRows}`,
      `epg=${docs.length}/${epgSources.length}`,
      `matched=${coverage.channelsWithPrograms}/${coverage.staticChannels}`,
      `coverage=${coverage.coveragePercent}%`,
      `priority=${priorityCoverage}`,
      `logos=${realLogosTotal}/${coverage.staticChannels}`,
      `identity-logos=${identityLogos.applied}`,
      `iptv-logos=${iptvOrg.logos.length}`,
      `iptv-reused=${(iptvOrg.reused || []).join(",") || "none"}`,
      `iptv-guides=${iptvOrg.guides.length}`,
      `country-epg=${countryUrls.length}/${countryReserve}`,
      `iptv-epg=${iptvUrls.length}`,
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
    res.send(buildMetadataM3u(state.lineup));
  } catch (error) {
    res.status(502).send(String(error.message || error));
  }
});

app.get("/jellyfin/event/:token", async (req, res) => {
  try {
    const id = String(req.params.token || "").replace(/\.ts$/i, "");
    const state = await refresh(false);
    const channel = state.lineup.find((row) => row.eventFailover && row.id === id);
    if (!channel) return res.status(404).json({ error: "event not found" });

    const selected = await selectWorkingEventCandidate(channel);
    if (!selected?.url) {
      return res.status(502).json({
        error: "no working event source",
        event: channel.name,
        candidates: channel.candidates?.length || 0,
      });
    }

    // Critical transport boundary: this endpoint is a finder only. It does not
    // proxy or rewrite media. Location is the exact original /play/live/... URL
    // copied from the raw Grok playlist.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("x-justone-event-quality", selected.quality || "");
    res.setHeader("x-justone-event-source", selected.label || "");
    res.statusCode = 302;
    res.setHeader("Location", selected.url);
    return res.end();
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
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

app.get("/jellyfin/diagnostics", async (req, res) => {
  try {
    const state = await refresh(req.query.refresh === "1");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      playback: "raw-grok-urls",
      failoverEvents: state.lineup.filter((ch) => ch.eventFailover).map((ch) => ({
        id: ch.id,
        name: ch.name,
        sources: ch.candidates?.length || 0,
        qualities: [...new Set((ch.candidates || []).map((candidate) => candidate.quality))],
      })),
      epg: state.epgStats,
      selectedSources: state.epgSources,
      priority: priorityDiagnostics(state.lineup, state.docs),
    });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.get("/jellyfin/artwork/:variant/:token.png", (req, res) => {
  const variant = req.params.variant === "channel" ? "channel" : "program";
  const context = artworkContext(cache.lineup, req.params.token);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(artworkPng(req.params.token, variant, context));
});

app.get("/jellyfin/links", async (_req, res) => {
  const state = await refresh(false).catch(() => cache);
  res.json({
    playlist: withKey(`${config.publicUrl}/jellyfin/playlist.m3u8`),
    guide: withKey(`${config.publicUrl}/jellyfin/guide.xml`),
    playback: "raw-grok-urls",
    channels: state.lineup.length,
    rawChannels: state.rawCount,
    failoverEvents: state.lineup.filter((ch) => ch.eventFailover).length,
    epgSources: state.docs.length,
    epgSelectedSources: state.epgSources.length,
    epgStats: state.epgStats,
  });
});

app.get("/jellyfin/health", (_req, res) => {
  res.json({
    service: "justone-jellyfin-live-metadata",
    ok: Boolean(cache.lineup.length) && !cache.error,
    playback: "raw-grok-urls",
    lastRefresh: cache.at ? new Date(cache.at).toISOString() : null,
    rawChannels: cache.rawCount,
    channels: cache.lineup.length,
    failoverEvents: cache.lineup.filter((ch) => ch.eventFailover).length,
    epgSources: cache.docs.length,
    epgSelectedSources: cache.epgSources.length,
    epgStats: cache.epgStats,
    error: cache.error,
  });
});

const refreshMs = Math.max(1, config.refreshMin) * 60 * 1000;
setInterval(() => refresh(false).catch(() => {}), refreshMs).unref?.();

app.listen(config.port, "0.0.0.0", () => {
  log(`JustOne Jellyfin metadata on :${config.port}`);
  refresh(true).catch((error) => log("initial refresh", String(error.message || error)));
});