import { config } from "./config.js";
import { loadGuide, loadSnapshot, loadState, saveGuide, saveSnapshot } from "./store.js";
import { parseM3u } from "./m3u.js";
import { canonicalGroup, canonicalIdentity, isBackup, qualityOf, variantRank } from "./identity.js";
import { enrichAndBuildGuide, guideSummary, parseXmlTv } from "./epg.js";
import { normalize, text, timeoutSignal } from "./util.js";

async function fetchText(url) {
  const response = await fetch(url, { signal: timeoutSignal(config.fetchTimeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return await response.text();
}

function sourcePriority(source) {
  return Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100;
}

function familyOrder(sources) {
  const enabled = [...sources].filter((s) => s.enabled !== false)
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
  for (const arr of bySource.values()) arr.sort((a, b) => a._variantRank - b._variantRank || a.name.localeCompare(b.name));

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

function buildRawChannels(sourceRows, state, previous) {
  const grouped = new Map();
  for (const item of sourceRows) {
    const identity = canonicalIdentity(item.row, state.aliases || {});
    const override = state.overrides?.[identity.id] || state.overrides?.[identity.key] || {};
    if (override.disabled) continue;
    const channel = grouped.get(identity.key) || {
      ...identity,
      name: text(override.name || identity.name),
      group: text(override.group || canonicalGroup(item.row)),
      logo: text(override.logo || ""),
      aliasNames: new Set(),
      variants: [],
    };
    channel.aliasNames.add(text(item.row.tvgName || item.row.name));
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
  let nextNumber = Math.max(999, ...oldNumbers.values().map(Number).filter(Number.isFinite)) + 1;
  const channels = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const channel of channels) {
    const override = state.overrides?.[channel.id] || state.overrides?.[channel.key] || {};
    channel.variants = orderVariantsBreadthFirst(channel.variants, state.sources || []);
    channel.aliasNames = [...channel.aliasNames];
    const requested = Number(override.number);
    channel.number = Number.isFinite(requested) && requested > 0
      ? requested
      : oldNumbers.get(channel.id) || nextNumber++;
  }
  return channels.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
}

export async function refreshCatalog() {
  const state = await loadState();
  const previous = await loadSnapshot();
  const sourceRows = [];
  const sourceStatus = [];

  for (const source of (state.sources || []).filter((s) => s.enabled !== false)) {
    try {
      const body = await fetchText(source.url);
      const rows = parseM3u(body);
      for (const row of rows) sourceRows.push({ source, row });
      sourceStatus.push({ id: source.id, name: source.name, ok: true, rows: rows.length });
    } catch (error) {
      sourceStatus.push({ id: source.id, name: source.name, ok: false, error: error.message });
    }
  }

  let channels = buildRawChannels(sourceRows, state, previous);

  // A playlist refresh failure must not erase a known-good source family.
  // Retain only variants from sources that were attempted and failed; disabled/removed
  // sources are intentionally not retained.
  const failedSourceIds = new Set(sourceStatus.filter((row) => !row.ok).map((row) => row.id));
  if (failedSourceIds.size) {
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    for (const old of previous.channels || []) {
      const retained = (old.variants || []).filter((variant) => failedSourceIds.has(variant.sourceId));
      if (!retained.length) continue;
      const current = byId.get(old.id);
      if (current) {
        const seen = new Set(current.variants.map((variant) => `${variant.sourceId}|${variant.url}`));
        current.variants.push(...retained.filter((variant) => !seen.has(`${variant.sourceId}|${variant.url}`)));
        current.variants = orderVariantsBreadthFirst(current.variants, state.sources || []);
        current.retainedDueToSourceFailure = true;
      } else {
        const restored = { ...old, variants: orderVariantsBreadthFirst(retained, state.sources || []), retainedDueToSourceFailure: true };
        channels.push(restored);
        byId.set(restored.id, restored);
      }
    }
    channels = channels.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  }

  const guideDocs = [];
  const guideStatus = [];
  for (const guide of [...(state.guides || [])].filter((g) => g.enabled !== false)
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

  // Reuse the previous generated XMLTV as the lowest-priority fallback when one
  // or more live guide sources fail. This prevents a transient EPG outage from
  // stripping programmes/logos from an otherwise healthy catalogue.
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
  };
  await saveSnapshot(snapshot);
  await saveGuide(guideXml);
  return snapshot;
}
