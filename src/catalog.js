import { config } from "./config.js";
import { loadGuide, loadSnapshot, loadState, saveGuide, saveSnapshot } from "./store.js";
import { parseM3uStream } from "./m3u.js";
import { canonicalGroup, canonicalIdentity, countryOf, isBackup, qualityOf, variantRank } from "./identity.js";
import { enrichAndBuildGuide, guideSummary, parseXmlTv } from "./epg.js";
import { buildDlhdReference, parse247Html, parseProtectedChannels, parseProtectedSchedule, parseScheduleHtml } from "./dlhd.js";
import { createDlhdMatcher } from "./dlhd-matcher.js";
import { text, timeoutSignal } from "./util.js";

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

async function scanSource(source, matcher, allowedCountries) {
  const response = await fetchPlaylist(source.url);
  const kept = [];
  const matchedRefs = new Set();
  let matchedInputRows = 0;

  const stats = await parseM3uStream(response.body, {
    maxLineLength: config.playlistMaxLineLength,
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
  });

  return { ...stats, kept, matchedInputRows, matchedRefs };
}

export async function refreshCatalog() {
  const state = await loadState();
  const previous = await loadSnapshot();
  const sourceStatus = [];
  const sourceRows = [];
  const matchedRefIds = new Set();
  let rawSourceRows = 0;
  let matchedInputRows = 0;
  const allowedCountries = new Set(config.dlhd.staticCountries || []);

  // Fetch the small DLHD desired-state first, then stream huge provider M3Us
  // through one precomputed matcher. Non-matches are discarded immediately.
  const { reference: dlhdReference, status: dlhdStatus } = await loadDlhdReference(previous);
  const matcher = dlhdReference ? createDlhdMatcher(dlhdReference, state.aliases || {}) : null;

  for (const source of (state.sources || []).filter((s) => s.enabled !== false)) {
    try {
      const scanned = await scanSource(source, matcher, allowedCountries);
      rawSourceRows += scanned.rows;
      matchedInputRows += scanned.matchedInputRows;
      sourceRows.push(...scanned.kept);
      for (const id of scanned.matchedRefs) matchedRefIds.add(id);
      sourceStatus.push({
        id: source.id,
        name: source.name,
        ok: true,
        rows: scanned.rows,
        matched: scanned.matchedInputRows,
        outputMappings: scanned.kept.length,
        bytes: scanned.bytes,
        megabytes: Number((scanned.bytes / 1024 / 1024).toFixed(1)),
      });
    } catch (error) {
      sourceStatus.push({ id: source.id, name: source.name, ok: false, error: error.message });
    }
  }

  if (dlhdReference) {
    const allRefs = [...(dlhdReference.channels || []), ...(dlhdReference.events || [])];
    const targetRefs = allRefs.filter((ref) => targetReference(ref, allowedCountries) || matchedRefIds.has(ref.id));
    dlhdStatus.staticCountries = [...allowedCountries];
    dlhdStatus.sourceRows = rawSourceRows;
    dlhdStatus.matchedInputRows = matchedInputRows;
    dlhdStatus.outputMappings = sourceRows.length;
    dlhdStatus.matchedReferences = matchedRefIds.size;
    dlhdStatus.totalReferences = targetRefs.length;
    dlhdStatus.unmatchedReferences = targetRefs
      .filter((ref) => !matchedRefIds.has(ref.id))
      .slice(0, 200)
      .map((ref) => ({ id: ref.id, kind: ref.kind, name: ref.name, group: ref.group || "" }));
  }

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
    } catch (error) {
      guideStatus.push({ id: guide.id, name: guide.name, ok: false, error: error.message });
    }
  }
  if (guideStatus.some((row) => !row.ok)) {
    try {
      const previousGuide = parseXmlTv(await loadGuide());
      guideDocs.push({ id: "__previous__", name: "Last known good guide", parsed: previousGuide });
    } catch {}
  }

  const guideXml = enrichAndBuildGuide(channels, guideDocs, state.overrides || {});
  const snapshot = {
    generatedAt: new Date().toISOString(),
    channels,
    sourceStatus,
    guideStatus,
    guideSummary: guideSummary(guideDocs),
    dlhdStatus,
    dlhdReference,
  };
  await saveSnapshot(snapshot);
  await saveGuide(guideXml);
  return snapshot;
}
