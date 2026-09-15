import { DispatcharrClient, reconcileDispatcharr as reconcileChannels } from "./dispatcharr.js";

const JUSTONE_EPG_NAME = "JustOne | Canonical EPG";

function propsOf(row) {
  const value = row?.custom_properties;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function isCanonicalEpg(row) {
  const props = propsOf(row);
  return row?.name === JUSTONE_EPG_NAME
    || (props.justone_managed === true && props.justone_role === "canonical_epg");
}

function idValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value.id ?? null;
  return value;
}

async function buildEpgPlan(snapshot, client, basePreview) {
  const policyIds = new Set(
    (basePreview.actions || [])
      .filter((row) => row.action === "policy-violation")
      .map((row) => row.tvgId)
  );
  const desired = (snapshot.channels || []).filter((row) => !policyIds.has(row.tvgId));

  const epgSources = await client.list("/api/epg/sources/");
  const epgSource = epgSources.find(isCanonicalEpg);
  if (!epgSource) {
    return {
      ready: false,
      blocker: `${JUSTONE_EPG_NAME} source is not present in Dispatcharr`,
      actions: desired.map((channel) => ({
        action: "waiting-for-epg",
        tvgId: channel.tvgId,
        name: channel.name,
        reason: "canonical EPG source missing",
      })),
      mappings: new Map(),
    };
  }

  const [epgData, channels] = await Promise.all([
    client.list("/api/epg/epgdata/"),
    client.list("/api/channels/channels/"),
  ]);
  const rows = epgData.filter((row) => String(idValue(row.epg_source)) === String(epgSource.id));
  const byTvg = new Map();
  for (const row of rows) {
    const key = String(row.tvg_id || "");
    if (!key) continue;
    const list = byTvg.get(key) || [];
    list.push(row);
    byTvg.set(key, list);
  }
  const channelsByTvg = new Map();
  for (const row of channels) {
    const key = String(row.tvg_id || "");
    if (!key.startsWith("justone.")) continue;
    const list = channelsByTvg.get(key) || [];
    list.push(row);
    channelsByTvg.set(key, list);
  }

  const actions = [];
  const mappings = new Map();
  let missing = 0;
  let duplicate = 0;
  for (const channel of desired) {
    const matches = byTvg.get(channel.tvgId) || [];
    if (!matches.length) {
      missing += 1;
      actions.push({ action: "waiting-for-epg", tvgId: channel.tvgId, name: channel.name });
      continue;
    }
    if (matches.length > 1) {
      duplicate += 1;
      actions.push({ action: "duplicate-epg-entry", tvgId: channel.tvgId, name: channel.name, ids: matches.map((row) => row.id) });
      continue;
    }
    const epg = matches[0];
    mappings.set(channel.tvgId, epg.id);
    const existing = (channelsByTvg.get(channel.tvgId) || [])[0];
    const current = idValue(existing?.epg_data_id ?? existing?.effective_epg_data_id);
    actions.push({
      action: current != null && String(current) === String(epg.id) ? "epg-unchanged" : "map-epg",
      id: existing?.id,
      tvgId: channel.tvgId,
      name: channel.name,
      epgDataId: epg.id,
    });
  }

  const blockers = [];
  if (missing) blockers.push(`${missing} channel(s) missing from ${JUSTONE_EPG_NAME}`);
  if (duplicate) blockers.push(`${duplicate} duplicate canonical EPG identity/identities`);
  return {
    ready: !missing && !duplicate,
    blocker: blockers.join("; "),
    actions,
    mappings,
    sourceId: epgSource.id,
    availableEntries: rows.length,
  };
}

export async function reconcileDispatcharr(snapshot, { apply = false, client = new DispatcharrClient() } = {}) {
  const basePreview = await reconcileChannels(snapshot, { apply: false, client });
  const epgPlan = await buildEpgPlan(snapshot, client, basePreview);
  const blockers = [...(basePreview.blockers || [])];
  if (!epgPlan.ready && epgPlan.blocker) blockers.push(epgPlan.blocker);
  const readyForApply = basePreview.readyForApply === true && epgPlan.ready;

  if (!apply) {
    const actions = [...(basePreview.actions || []), ...epgPlan.actions];
    const counts = actions.reduce((acc, row) => ((acc[row.action] = (acc[row.action] || 0) + 1), acc), {});
    return {
      ...basePreview,
      readyForApply,
      blockers,
      counts,
      actions,
      epg: {
        source: JUSTONE_EPG_NAME,
        sourceId: epgPlan.sourceId || null,
        availableEntries: epgPlan.availableEntries || 0,
        mappedDesired: epgPlan.mappings.size,
      },
      note: readyForApply
        ? "Channel and canonical EPG reconciliation are ready to apply."
        : "Do not apply yet. Refresh the JustOne M3Us/Canonical EPG and resolve the reported blockers first.",
    };
  }

  if (!readyForApply) {
    throw new Error(`Dispatcharr apply blocked: ${blockers.join("; ") || "preview is not ready"}`);
  }

  const baseResult = await reconcileChannels(snapshot, { apply: true, client });
  const currentChannels = await client.list("/api/channels/channels/");
  const byTvg = new Map(
    currentChannels
      .filter((row) => String(row.tvg_id || "").startsWith("justone."))
      .map((row) => [row.tvg_id, row])
  );
  const epgActions = [];
  for (const [tvgId, epgDataId] of epgPlan.mappings) {
    const channel = byTvg.get(tvgId);
    if (!channel) throw new Error(`Dispatcharr EPG mapping failed: managed channel ${tvgId} was not found after reconcile`);
    const current = idValue(channel.epg_data_id ?? channel.effective_epg_data_id);
    if (current != null && String(current) === String(epgDataId)) {
      epgActions.push({ action: "epg-unchanged", id: channel.id, tvgId, epgDataId });
      continue;
    }
    await client.request(`/api/channels/channels/${channel.id}/`, {
      method: "PATCH",
      body: { epg_data_id: epgDataId },
    });
    epgActions.push({ action: "map-epg", id: channel.id, tvgId, epgDataId });
  }

  const actions = [...(baseResult.actions || []), ...epgActions];
  const counts = actions.reduce((acc, row) => ((acc[row.action] = (acc[row.action] || 0) + 1), acc), {});
  return {
    ...baseResult,
    readyForApply: true,
    blockers: [],
    actions,
    counts,
    epg: {
      source: JUSTONE_EPG_NAME,
      sourceId: epgPlan.sourceId,
      availableEntries: epgPlan.availableEntries,
      mappedDesired: epgPlan.mappings.size,
    },
    note: `Channel reconciliation applied and ${epgActions.filter((row) => row.action === "map-epg").length} channel EPG mapping(s) updated.`,
  };
}
