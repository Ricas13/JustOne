import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";
import {
  ensureProviderCacheDir,
  loadGuide,
  loadProviderCacheMeta,
  loadSnapshot,
  loadState,
  providerCacheExists,
  providerCachePath,
  saveGuide,
  saveProviderCacheMeta,
  saveSnapshot,
} from "./store.js";
import { parseM3uStream } from "./m3u.js";
import { canonicalGroup, canonicalIdentity, countryOf, isBackup, qualityOf, variantRank } from "./identity.js";
import { enrichAndBuildGuide, guideSummary, parseXmlTv } from "./epg.js";
import { buildDlhdReference, parse247Html, parseProtectedChannels, parseProtectedSchedule, parseScheduleHtml } from "./dlhd.js";
import { createDlhdMatcher } from "./dlhd-matcher.js";
import { text, timeoutSignal } from "./util.js";

function elapsedSeconds(started) {
  return Number(((Date.now() - started) / 1000).toFixed(1));
}

function report(onProgress, payload) {
  try { onProgress?.(payload); } catch (error) { console.warn("Refresh progress callback failed:", error.message); }
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: timeoutSignal(config.fetchTimeoutMs),
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 JustOne Catalog", accept: "*/*" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return await response.text();
}

async function fetchPlaylist(url) {
  const response = await fetch(url, {
    signal: timeoutSignal(config.playlistFetchTimeoutMs),
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 JustOne Catalog", accept: "audio/x-mpegurl,application/x-mpegURL,text/plain,*/*" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("playlist response has no body");
  return response;
}

function sourcePriority(source) {
  return Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100;
}

function familyOrder(sources) {
  const enabled = [...sources]
    .filter((s) => s.enabled !== false)
    .sort((a, b) => sourcePriority(a) - sourcePriority(b) || text(a.name).localeCompare(text(b.name)));
  const byProvider = new Map();
  for (const source of enabled) {
    const provider = text(source.provider || source.name || source.id);
    const arr = byProvider.get(provider) || [];
    arr.push(source);
    byProvider.set(provider, arr);
  }
  const providers = [...byProvider.entries()].sort((a, b) => {
    const ap = Math.min(...a[1].map(sourcePriority));
    const bp = Math.min(...b[1].map(sourcePriority));
    return ap - bp || a[0].localeCompare(b[0]);
  });
  const out = [];
  const max = Math.max(0, ...providers.map(([, arr]) => arr.length));
  for (let depth = 0; depth < max; depth++) {
    for (const [, arr] of providers) if (arr[depth]) out.push(arr[depth]);
  }
  return out;
}

export function orderVariantsBreadthFirst(variants, sources, defaultQualityOrder = config.qualityOrder) {
  const families = familyOrder(sources);
  const bySource = new Map();
  for (const variant of variants) {
    const source = sources.find((s) => s.id === variant.sourceId);
    const qualityOrder = Array.isArray(source?.qualityOrder) && source.qualityOrder.length
      ? source.qualityOrder.map((x) => String(x).toUpperCase())
      : defaultQualityOrder;
    const arr = bySource.get(variant.sourceId) || [];
    arr.push({ ...variant, _variantRank: variantRank(variant, qualityOrder) });
    bySource.set(variant.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort((a, b) => a._variantRank - b._variantRank || a.name.localeCompare(b.name));
  }
  const ordered = [];
  const maxDepth = Math.max(0, ...[...bySource.values()].map((arr) => arr.length));
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const source of families) {
      const variant = bySource.get(source.id)?.[depth];
      if (variant) ordered.push(variant);
    }
  }
  return ordered.map(({ _variantRank, ...variant }, order) => ({ ...variant, order }));
}

async function fetchDlhdProtected(endpoint) {
  const url = new URL(`${config.dlhd.baseUrl}/daddyapi.php`);
  url.searchParams.set("key", config.dlhd.apiKey);
  url.searchParams.set("endpoint", endpoint);
  const payload = JSON.parse(await fetchText(url.toString()));
  if (payload?.success === false) throw new Error(payload.message || payload.error || `DLHD ${endpoint} API failed`);
  return payload;
}

async function freshDlhdChannels() {
  if (config.dlhd.apiKey) {
    try {
      const rows = parseProtectedChannels(await fetchDlhdProtected("channels"), config.dlhd.baseUrl);
      if (rows.length) return { rows, mode: "api" };
    } catch (error) {
      console.warn("DLHD protected channels failed; falling back to public page:", error.message);
    }
  }
  const rows = parse247Html(await fetchText(`${config.dlhd.baseUrl}/24-7-channels.php`), config.dlhd.baseUrl);
  if (!rows.length) throw new Error("DLHD 24/7 catalogue returned no channels");
  return { rows, mode: "html" };
}

async function freshDlhdSchedule() {
  if (config.dlhd.apiKey) {
    try {
      const parsed = parseProtectedSchedule(await fetchDlhdProtected("schedule"), config.dlhd.baseUrl);
      if (parsed.events.length) return { parsed, mode: "api" };
    } catch (error) {
      console.warn("DLHD protected schedule failed; falling back to public page:", error.message);
    }
  }
  const parsed = parseScheduleHtml(await fetchText(`${config.dlhd.baseUrl}/`), config.dlhd.baseUrl);
  if (!parsed.events.length) throw new Error("DLHD public schedule returned no events");
  return { parsed, mode: "html" };
}

async function loadDlhdReference(previous) {
  if (!config.dlhd.enabled) return { reference: null, status: { enabled: false } };
  const old = previous.dlhdReference || { channels: [], events: [] };
  let channelsRaw = null;
  let scheduleRaw = null;
  let channelsMode = "disabled";
  let scheduleMode = "disabled";
  let channelsError = "";
  let scheduleError = "";

  if (config.dlhd.include247) {
    try {
      const result = await freshDlhdChannels();
      channelsRaw = result.rows;
      channelsMode = result.mode;
    } catch (error) {
      channelsError = error.message;
    }
  }
  if (config.dlhd.includeSchedule) {
    try {
      const result = await freshDlhdSchedule();
      scheduleRaw = result.parsed;
      scheduleMode = result.mode;
    } catch (error) {
      scheduleError = error.message;
    }
  }

  const fresh = buildDlhdReference({
    channels: channelsRaw || [],
    schedule: scheduleRaw || { events: [] },
    mode: [channelsMode, scheduleMode].filter((x) => x !== "disabled").join("+") || "none",
  });
  const channels = config.dlhd.include247 ? (channelsRaw ? fresh.channels : old.channels || []) : [];
  let events = config.dlhd.includeSchedule ? (scheduleRaw ? fresh.events : old.events || []) : [];
  if (!config.dlhd.includeUpcoming) events = events.filter((event) => !event.upcoming);

  const missingRequired = (config.dlhd.include247 && !channels.length) || (config.dlhd.includeSchedule && !events.length);
  if (missingRequired && config.dlhd.failClosed) {
    const detail = [channelsError && `channels: ${channelsError}`, scheduleError && `schedule: ${scheduleError}`]
      .filter(Boolean).join("; ");
    throw new Error(`DLHD reference unavailable; refusing to publish unfiltered IPTV catalogue${detail ? ` (${detail})` : ""}`);
  }

  return {
    reference: { generatedAt: new Date().toISOString(), mode: fresh.mode, channels, events },
    status: {
      enabled: true,
      channels: channels.length,
      events: events.length,
      channelsMode: channelsRaw ? channelsMode : "last-known-good",
      scheduleMode: scheduleRaw ? scheduleMode : "last-known-good",
      channelsError,
      scheduleError,
      retainedChannels: !channelsRaw && channels.length > 0,
      retainedSchedule: !scheduleRaw && events.length > 0,
    },
  };
}

function buildRawChannels(sourceRows, state, previous) {
  const grouped = new Map();
  for (const item of sourceRows) {
    const ref = item.reference;
    const identity = ref
      ? { key: ref.key, id: ref.id, tvgId: ref.tvgId, name: ref.name }
      : canonicalIdentity(item.row, state.aliases || {});
    const override = state.overrides?.[identity.id] || state.overrides?.[identity.key] || {};
    if (override.disabled) continue;

    const channel = grouped.get(identity.key) || {
      ...identity,
      name: text(override.name || identity.name),
      group: text(override.group || ref?.group || canonicalGroup(item.row)),
      logo: text(override.logo || ref?.logo || ""),
      aliasNames: new Set(),
      variants: [],
      referenceKind: ref?.kind || "provider",
      dlhdRefId: ref?.id || null,
      dlhdId: ref?.dlhdId || null,
      event: ref?.kind === "event"
        ? { start: ref.start, end: ref.end, time: ref.time, category: ref.category, linkedChannels: ref.linkedChannels || [] }
        : null,
    };
    channel.aliasNames.add(text(item.row.tvgName || item.row.name));
    for (const alias of ref?.aliases || []) channel.aliasNames.add(text(alias));
    channel.variants.push({
      sourceId: item.source.id,
      sourceName: item.source.name,
      provider: text(item.source.provider || item.source.name),
      account: text(item.source.account || item.source.name),
      maxStreams: Number(item.source.maxStreams || 1),
      name: item.row.name,
      url: item.row.url,
      originalTvgId: item.row.tvgId,
      logo: item.row.logo,
      quality: qualityOf(`${item.row.name} ${item.row.group}`),
      backup: isBackup(`${item.row.name} ${item.row.group}`),
    });
    grouped.set(identity.key, channel);
  }

  const oldNumbers = new Map((previous.channels || []).map((ch) => [ch.id, ch.number]));
  const staticOld = [...(previous.channels || [])]
    .filter((ch) => ch.referenceKind !== "event")
    .map((ch) => Number(ch.number)).filter((n) => Number.isFinite(n) && n < 90000);
  const eventOld = [...(previous.channels || [])]
    .filter((ch) => ch.referenceKind === "event")
    .map((ch) => Number(ch.number)).filter((n) => Number.isFinite(n) && n >= 90000);
  let nextNumber = Math.max(999, ...staticOld) + 1;
  let nextEvent = Math.max(89999, ...eventOld) + 1;
  const channels = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));

  for (const channel of channels) {
    const override = state.overrides?.[channel.id] || state.overrides?.[channel.key] || {};
    channel.variants = orderVariantsBreadthFirst(channel.variants, state.sources || []);
    channel.aliasNames = [...channel.aliasNames];
    const requested = Number(override.number);
    channel.number = Number.isFinite(requested) && requested > 0
      ? requested
      : oldNumbers.get(channel.id) || (channel.referenceKind === "event" ? nextEvent++ : nextNumber++);
  }
  return channels.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
}

function staticCountry(row, ref) {
  return countryOf(row) || countryOf({ name: ref?.name || "", group: ref?.group || "" });
}

export function mappingAllowedForCountries(row, ref, countries) {
  const allowed = countries instanceof Set ? countries : new Set(countries || []);
  if (ref?.kind === "event") return true;
  if (!ref || !allowed.size) return true;
  return allowed.has(staticCountry(row, ref));
}

function targetReference(ref, allowedCountries) {
  if (ref.kind === "event") return true;
  if (!allowedCountries.size) return true;
  return allowedCountries.has(countryOf({ name: ref.name || "", group: ref.group || "" }));
}

async function cacheState(source) {
  const exists = await providerCacheExists(source.id);
  const meta = exists ? await loadProviderCacheMeta(source.id) : null;
  const urlMatches = Boolean(meta && meta.url === source.url);
  const cachedAtMs = Date.parse(meta?.cachedAt || "");
  const maxAgeMs = config.providerCacheMaxAgeMinutes * 60 * 1000;
  const fresh = exists && urlMatches && Number.isFinite(cachedAtMs) && (Date.now() - cachedAtMs) <= maxAgeMs;
  return { exists, meta, urlMatches, fresh };
}

async function scanSource(source, matcher, allowedCountries, onProgress, sourceMode = "auto") {
  const kept = [];
  const matchedRefs = new Set();
  let matchedInputRows = 0;
  const cache = await cacheState(source);
  let readable;
  let input = "provider";
  let cacheHandle = null;
  let tmpPath = null;
  let response = null;

  const useCache = sourceMode === "cache"
    ? cache.exists && cache.urlMatches
    : sourceMode === "auto"
      ? cache.fresh
      : false;

  if (useCache) {
    readable = fs.createReadStream(providerCachePath(source.id));
    input = "cache";
  } else {
    try {
      response = await fetchPlaylist(source.url);
      readable = response.body;
      await ensureProviderCacheDir();
      tmpPath = `${providerCachePath(source.id)}.${process.pid}.${Date.now()}.tmp`;
      cacheHandle = await fsp.open(tmpPath, "w");
      input = "provider";
    } catch (error) {
      if (cache.exists && cache.urlMatches) {
        console.warn(`Source ${source.name}: provider fetch failed (${error.message}); using last cached M3U`);
        readable = fs.createReadStream(providerCachePath(source.id));
        input = "cache-fallback";
      } else {
        throw error;
      }
    }
  }

  let stats;
  try {
    stats = await parseM3uStream(readable, {
      maxLineLength: config.playlistMaxLineLength,
      onChunk: cacheHandle ? async (chunk) => { await cacheHandle.write(chunk); } : undefined,
      onRow: (row) => {
        if (!matcher) {
          kept.push({ source, row });
          matchedInputRows += 1;
          return;
        }
        const refs = matcher.match(row);
        let accepted = 0;
        for (const ref of refs) {
          if (!mappingAllowedForCountries(row, ref, allowedCountries)) continue;
          kept.push({ source, row, reference: ref });
          matchedRefs.add(ref.id);
          accepted += 1;
        }
        if (accepted) matchedInputRows += 1;
      },
      onProgress: ({ rows, bytes }) => {
        report(onProgress, {
          phase: "scanning-source",
          currentSource: source.name,
          sourceId: source.id,
          sourceInput: input,
          rows,
          bytes,
          megabytes: Number((bytes / 1024 / 1024).toFixed(1)),
          matchedInputRows,
          outputMappings: kept.length,
        });
      },
    });
  } catch (error) {
    if (cacheHandle) {
      try { await cacheHandle.close(); } catch {}
      try { await fsp.rm(tmpPath, { force: true }); } catch {}
      cacheHandle = null;
    }
    throw error;
  }

  if (cacheHandle) {
    await cacheHandle.close();
    await fsp.rename(tmpPath, providerCachePath(source.id));
    const cachedAt = new Date().toISOString();
    await saveProviderCacheMeta(source.id, {
      sourceId: source.id,
      name: source.name,
      url: source.url,
      cachedAt,
      bytes: stats.bytes,
      rows: stats.rows,
    });
    cache.meta = { ...(cache.meta || {}), cachedAt, url: source.url, bytes: stats.bytes, rows: stats.rows };
  }

  return {
    ...stats,
    kept,
    matchedInputRows,
    matchedRefs,
    input,
    cachedAt: input === "provider" ? new Date().toISOString() : cache.meta?.cachedAt || null,
  };
}

export async function refreshCatalog({ onProgress, sourceMode = "auto" } = {}) {
  const started = Date.now();
  const state = await loadState();
  const previous = await loadSnapshot();
  const sourceStatus = [];
  const sourceRows = [];
  const matchedRefIds = new Set();
  let rawSourceRows = 0;
  let matchedInputRows = 0;
  const allowedCountries = new Set(config.dlhd.staticCountries || []);
  const enabledSources = (state.sources || []).filter((s) => s.enabled !== false);

  console.log(`Catalog refresh: ${enabledSources.length} enabled source(s); sourceMode=${sourceMode}; countries=${[...allowedCountries].join(",") || "all"}`);
  report(onProgress, { phase: "loading-dlhd", currentSource: null, sourceMode, sourcesTotal: enabledSources.length });

  const { reference: dlhdReference, status: dlhdStatus } = await loadDlhdReference(previous);
  const matcher = dlhdReference ? createDlhdMatcher(dlhdReference, state.aliases || {}) : null;

  if (dlhdStatus?.channelsError) console.warn(`DLHD channels refresh warning: ${dlhdStatus.channelsError}`);
  if (dlhdStatus?.scheduleError) console.warn(`DLHD schedule refresh warning: ${dlhdStatus.scheduleError}`);
  console.log(`DLHD reference: ${dlhdReference?.channels?.length || 0} channels + ${dlhdReference?.events?.length || 0} events (${dlhdReference?.mode || "disabled"})`);
  report(onProgress, {
    phase: "scanning-sources",
    sourceMode,
    dlhdChannels: dlhdReference?.channels?.length || 0,
    dlhdEvents: dlhdReference?.events?.length || 0,
  });

  for (let i = 0; i < enabledSources.length; i++) {
    const source = enabledSources[i];
    const sourceStarted = Date.now();
    console.log(`Source ${i + 1}/${enabledSources.length} ${source.name}: starting (${sourceMode})`);
    report(onProgress, {
      phase: "scanning-source",
      currentSource: source.name,
      sourceId: source.id,
      sourceMode,
      sourceIndex: i + 1,
      sourcesTotal: enabledSources.length,
      rows: 0,
      bytes: 0,
      megabytes: 0,
      matchedInputRows: 0,
      outputMappings: 0,
    });
    try {
      const scanned = await scanSource(source, matcher, allowedCountries, onProgress, sourceMode);
      rawSourceRows += scanned.rows;
      matchedInputRows += scanned.matchedInputRows;
      sourceRows.push(...scanned.kept);
      for (const id of scanned.matchedRefs) matchedRefIds.add(id);
      const status = {
        id: source.id,
        name: source.name,
        ok: true,
        input: scanned.input,
        cachedAt: scanned.cachedAt,
        rows: scanned.rows,
        matched: scanned.matchedInputRows,
        outputMappings: scanned.kept.length,
        bytes: scanned.bytes,
        megabytes: Number((scanned.bytes / 1024 / 1024).toFixed(1)),
        seconds: elapsedSeconds(sourceStarted),
      };
      sourceStatus.push(status);
      console.log(`Source ${source.name}: ${status.input}; ${status.rows.toLocaleString()} rows / ${status.megabytes} MB; ${status.matched.toLocaleString()} input rows matched; ${status.outputMappings.toLocaleString()} mappings; ${status.seconds}s`);
    } catch (error) {
      const status = { id: source.id, name: source.name, ok: false, error: error.message, seconds: elapsedSeconds(sourceStarted) };
      sourceStatus.push(status);
      console.error(`Source ${source.name} failed after ${status.seconds}s: ${error.message}`);
      report(onProgress, {
        phase: "source-error",
        currentSource: source.name,
        sourceId: source.id,
        sourceIndex: i + 1,
        sourcesTotal: enabledSources.length,
        error: error.message,
      });
    }
  }

  if (dlhdReference) {
    const allRefs = [...(dlhdReference.channels || []), ...(dlhdReference.events || [])];
    const refById = new Map(allRefs.map((ref) => [ref.id, ref]));
    const targetRefs = allRefs.filter((ref) => targetReference(ref, allowedCountries) || matchedRefIds.has(ref.id));
    const targetChannelRefs = targetRefs.filter((ref) => ref.kind === "channel");
    const targetEventRefs = targetRefs.filter((ref) => ref.kind === "event");
    const matchedChannels = [...matchedRefIds].filter((id) => refById.get(id)?.kind === "channel").length;
    const matchedEvents = [...matchedRefIds].filter((id) => refById.get(id)?.kind === "event").length;
    dlhdStatus.staticCountries = [...allowedCountries];
    dlhdStatus.referenceChannels = dlhdReference.channels?.length || 0;
    dlhdStatus.referenceEvents = dlhdReference.events?.length || 0;
    dlhdStatus.targetChannelReferences = targetChannelRefs.length;
    dlhdStatus.targetEventReferences = targetEventRefs.length;
    dlhdStatus.sourceRows = rawSourceRows;
    dlhdStatus.matchedInputRows = matchedInputRows;
    dlhdStatus.outputMappings = sourceRows.length;
    dlhdStatus.matchedReferences = matchedRefIds.size;
    dlhdStatus.matchedChannelReferences = matchedChannels;
    dlhdStatus.matchedEventReferences = matchedEvents;
    dlhdStatus.totalReferences = targetRefs.length;
    dlhdStatus.unmatchedReferences = targetRefs
      .filter((ref) => !matchedRefIds.has(ref.id))
      .slice(0, 200)
      .map((ref) => ({ id: ref.id, kind: ref.kind, name: ref.name, group: ref.group || "" }));
  }

  report(onProgress, { phase: "building-catalog", currentSource: null });
  let channels = buildRawChannels(sourceRows, state, previous);
  const failedSourceIds = new Set(sourceStatus.filter((row) => !row.ok).map((row) => row.id));
  const allowedDlhdIds = dlhdReference
    ? new Set([...(dlhdReference.channels || []), ...(dlhdReference.events || [])].map((ref) => ref.id))
    : null;

  if (failedSourceIds.size) {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    for (const old of previous.channels || []) {
      if (allowedDlhdIds && (!old.dlhdRefId || !allowedDlhdIds.has(old.dlhdRefId))) continue;
      if (old.referenceKind !== "event" && allowedCountries.size) {
        const oldCountry = String(old.group || "").match(/TV\s*\|\s*(GB|PT|US)\b/i)?.[1]?.toUpperCase() || "";
        if (!allowedCountries.has(oldCountry)) continue;
      }
      const retained = (old.variants || []).filter((variant) => failedSourceIds.has(variant.sourceId));
      if (!retained.length) continue;
      const current = byId.get(old.id);
      if (current) {
        const seen = new Set(current.variants.map((variant) => `${variant.sourceId}|${variant.url}`));
        current.variants.push(...retained.filter((variant) => !seen.has(`${variant.sourceId}|${variant.url}`)));
        current.variants = orderVariantsBreadthFirst(current.variants, state.sources || []);
        current.retainedDueToSourceFailure = true;
      } else {
        const restored = {
          ...old,
          variants: orderVariantsBreadthFirst(retained, state.sources || []),
          retainedDueToSourceFailure: true,
        };
        channels.push(restored);
        byId.set(restored.id, restored);
      }
    }
    channels = channels.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  }

  const outputStaticChannels = channels.filter((channel) => channel.referenceKind !== "event").length;
  const outputEvents = channels.filter((channel) => channel.referenceKind === "event").length;
  if (dlhdStatus) {
    dlhdStatus.outputStaticChannels = outputStaticChannels;
    dlhdStatus.outputEvents = outputEvents;
  }

  report(onProgress, { phase: "loading-guides", outputStaticChannels, outputEvents });
  const guideDocs = [];
  const guideStatus = [];
  for (const guide of [...(state.guides || [])]
    .filter((g) => g.enabled !== false)
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100))) {
    try {
      const body = await fetchText(guide.url);
      const parsed = parseXmlTv(body);
      guideDocs.push({ ...guide, parsed });
      guideStatus.push({ id: guide.id, name: guide.name, ok: true, channels: parsed.channels.size });
      console.log(`Guide ${guide.name}: ${parsed.channels.size} channels`);
    } catch (error) {
      guideStatus.push({ id: guide.id, name: guide.name, ok: false, error: error.message });
      console.error(`Guide ${guide.name} failed: ${error.message}`);
    }
  }
  if (guideStatus.some((row) => !row.ok)) {
    try {
      const previousGuide = parseXmlTv(await loadGuide());
      guideDocs.push({ id: "__previous__", name: "Last known good guide", parsed: previousGuide });
      console.warn("Using last-known-good generated guide because at least one XMLTV source failed");
    } catch {}
  }

  const guideXml = enrichAndBuildGuide(channels, guideDocs, state.overrides || {});
  const snapshot = {
    generatedAt: new Date().toISOString(),
    sourceMode,
    channels,
    sourceStatus,
    guideStatus,
    guideSummary: guideSummary(guideDocs),
    dlhdStatus,
    dlhdReference,
  };
  await saveSnapshot(snapshot);
  await saveGuide(guideXml);
  report(onProgress, { phase: "complete", currentSource: null, outputStaticChannels, outputEvents });
  console.log(`Catalog refresh complete in ${elapsedSeconds(started)}s: ${outputStaticChannels} static + ${outputEvents} events = ${channels.length} channels`);
  return snapshot;
}
