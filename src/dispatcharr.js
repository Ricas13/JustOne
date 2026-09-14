import { config, withInternalKey } from "./config.js";
import { text, timeoutSignal } from "./util.js";

const JUSTONE_EPG_NAME = "JustOne | Canonical EPG";

function rankFromName(name) {
  const match = /\[JO:(\d+)\]/i.exec(String(name || ""));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

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

function isManagedAccount(row) {
  const props = propsOf(row);
  return props.justone_managed === true && props.justone_role === "filtered_m3u" && Boolean(props.justone_source_id);
}

function managedSourceId(row) {
  return isManagedAccount(row) ? String(propsOf(row).justone_source_id) : "";
}

function isManagedEpg(row) {
  const props = propsOf(row);
  return props.justone_managed === true && props.justone_role === "canonical_epg";
}

function desiredAccount(source) {
  const internalUrl = withInternalKey(`${config.internalBaseUrl}/m3u/source/${encodeURIComponent(source.id)}.m3u`);
  return {
    name: `JustOne | ${text(source.name)}`.slice(0, 255),
    server_url: internalUrl,
    max_streams: Math.max(1, Number(source.maxStreams || 1)),
    is_active: source.enabled !== false,
    account_type: "STD",
    refresh_interval: 0,
    stale_stream_days: 7,
    priority: Math.max(0, Number(source.priority || 0)),
    enable_vod: false,
    auto_enable_new_groups_live: true,
    auto_enable_new_groups_vod: false,
    auto_enable_new_groups_series: false,
    custom_properties: {
      justone_managed: true,
      justone_role: "filtered_m3u",
      justone_source_id: source.id,
    },
  };
}

function desiredEpg() {
  return {
    name: JUSTONE_EPG_NAME,
    source_type: "xmltv",
    url: withInternalKey(`${config.internalBaseUrl}/epg/guide.xml`),
    is_active: true,
    refresh_interval: 0,
    priority: 100,
    custom_properties: {
      justone_managed: true,
      justone_role: "canonical_epg",
    },
  };
}

function accountNeedsUpdate(existing, desired) {
  const fields = ["name", "server_url", "max_streams", "is_active", "account_type", "refresh_interval", "stale_stream_days", "priority"];
  if (fields.some((key) => (existing?.[key] ?? null) !== (desired?.[key] ?? null))) return true;
  const props = propsOf(existing);
  return props.justone_managed !== true || props.justone_role !== "filtered_m3u" || props.justone_source_id !== desired.custom_properties.justone_source_id;
}

function epgNeedsUpdate(existing, desired) {
  const fields = ["name", "source_type", "url", "is_active", "refresh_interval", "priority"];
  if (fields.some((key) => (existing?.[key] ?? null) !== (desired?.[key] ?? null))) return true;
  const props = propsOf(existing);
  return props.justone_managed !== true || props.justone_role !== "canonical_epg";
}

function safeInputAction(action) {
  const { desired, ...safe } = action;
  if (desired?.server_url) safe.internalPath = new URL(desired.server_url).pathname;
  if (desired?.url) safe.internalPath = new URL(desired.url).pathname;
  return safe;
}

export class DispatcharrClient {
  constructor(settings = config.dispatcharr) {
    this.settings = settings;
    this.token = "";
  }

  async authHeaders() {
    if (this.settings.apiKey) return { "X-API-Key": this.settings.apiKey };
    if (!this.token) {
      if (!this.settings.username || !this.settings.password) {
        throw new Error("Dispatcharr requires DISPATCHARR_API_KEY or username/password");
      }
      const response = await fetch(`${this.settings.url}/api/accounts/token/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: this.settings.username, password: this.settings.password }),
        signal: timeoutSignal(config.fetchTimeoutMs),
      });
      if (!response.ok) throw new Error(`Dispatcharr login failed: HTTP ${response.status}`);
      const data = await response.json();
      this.token = data.access;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.settings.url) throw new Error("DISPATCHARR_URL is not configured");
    const headers = { ...(await this.authHeaders()) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.settings.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(config.fetchTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Dispatcharr ${method} ${path} failed: HTTP ${response.status}${detail ? ` - ${detail.slice(0, 300)}` : ""}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return { ok: true, text: await response.text() };
    return await response.json();
  }

  async list(path) {
    let page = 1;
    const out = [];
    while (true) {
      const join = path.includes("?") ? "&" : "?";
      const data = await this.request(`${path}${join}page=${page}&page_size=10000`);
      if (Array.isArray(data)) return [...out, ...data];
      out.push(...(data.results || []));
      if (!data.next || !(data.results || []).length) return out;
      page += 1;
    }
  }
}

export async function planDispatcharrInputs(state, { client = new DispatcharrClient() } = {}) {
  const [accounts, epgSources] = await Promise.all([
    client.list("/api/m3u/accounts/"),
    client.list("/api/epg/sources/"),
  ]);

  const actions = [];
  const stateSourceIds = new Set((state.sources || []).map((source) => String(source.id)));

  for (const source of state.sources || []) {
    const desired = desiredAccount(source);
    const managed = accounts.find((row) => managedSourceId(row) === String(source.id));
    const nameConflict = accounts.find((row) => row.name === desired.name && row.id !== managed?.id);

    if (!managed && nameConflict) {
      actions.push({ type: "m3u", action: "conflict", sourceId: source.id, name: desired.name, existingId: nameConflict.id });
      continue;
    }
    if (!managed) {
      if (source.enabled !== false) actions.push({ type: "m3u", action: "create", sourceId: source.id, name: desired.name, desired });
      continue;
    }
    if (source.enabled === false) {
      if (managed.is_active !== false) actions.push({ type: "m3u", action: "disable", sourceId: source.id, id: managed.id, name: managed.name, desired: { ...desired, is_active: false } });
      else actions.push({ type: "m3u", action: "unchanged", sourceId: source.id, id: managed.id, name: managed.name });
      continue;
    }
    actions.push({
      type: "m3u",
      action: accountNeedsUpdate(managed, desired) ? "update" : "unchanged",
      sourceId: source.id,
      id: managed.id,
      name: desired.name,
      desired,
    });
  }

  for (const account of accounts.filter(isManagedAccount)) {
    const sourceId = managedSourceId(account);
    if (!stateSourceIds.has(sourceId)) {
      actions.push({ type: "m3u", action: "orphan", sourceId, id: account.id, name: account.name });
    }
  }

  const epgDesired = desiredEpg();
  const managedEpg = epgSources.find(isManagedEpg);
  const epgNameConflict = epgSources.find((row) => row.name === epgDesired.name && row.id !== managedEpg?.id);
  if (!managedEpg && epgNameConflict) {
    actions.push({ type: "epg", action: "conflict", name: epgDesired.name, existingId: epgNameConflict.id });
  } else if (!managedEpg) {
    actions.push({ type: "epg", action: "create", name: epgDesired.name, desired: epgDesired });
  } else {
    actions.push({
      type: "epg",
      action: epgNeedsUpdate(managedEpg, epgDesired) ? "update" : "unchanged",
      id: managedEpg.id,
      name: epgDesired.name,
      desired: epgDesired,
    });
  }

  const safeActions = actions.map(safeInputAction);
  return {
    actions,
    safe: {
      counts: safeActions.reduce((acc, row) => ((acc[`${row.type}:${row.action}`] = (acc[`${row.type}:${row.action}`] || 0) + 1), acc), {}),
      actions: safeActions,
    },
  };
}

export async function provisionDispatcharrInputs(state, { apply = false, refresh = false, client = new DispatcharrClient() } = {}) {
  if (apply && !config.dispatcharr.applyEnabled) {
    throw new Error("Dispatcharr apply is disabled. Set DISPATCHARR_APPLY_ENABLED=true after reviewing preview output.");
  }

  const plan = await planDispatcharrInputs(state, { client });
  if (!apply) return { apply: false, refresh: false, ...plan.safe };

  const accountIds = new Map();
  let epgId = null;
  const applied = [];

  for (const row of plan.actions) {
    if (["conflict", "orphan", "unchanged"].includes(row.action)) {
      applied.push(safeInputAction(row));
      if (row.type === "m3u" && row.id && row.sourceId) accountIds.set(String(row.sourceId), row.id);
      if (row.type === "epg" && row.id) epgId = row.id;
      continue;
    }

    if (row.type === "m3u") {
      let result;
      if (row.action === "create") result = await client.request("/api/m3u/accounts/", { method: "POST", body: row.desired });
      else result = await client.request(`/api/m3u/accounts/${row.id}/`, { method: "PATCH", body: row.desired });
      const id = result?.id || row.id;
      if (id && row.sourceId) accountIds.set(String(row.sourceId), id);
      applied.push({ ...safeInputAction(row), id });
      continue;
    }

    if (row.type === "epg") {
      let result;
      if (row.action === "create") result = await client.request("/api/epg/sources/", { method: "POST", body: row.desired });
      else result = await client.request(`/api/epg/sources/${row.id}/`, { method: "PATCH", body: row.desired });
      epgId = result?.id || row.id;
      applied.push({ ...safeInputAction(row), id: epgId });
    }
  }

  const refreshActions = [];
  if (refresh) {
    for (const source of (state.sources || []).filter((row) => row.enabled !== false)) {
      const accountId = accountIds.get(String(source.id));
      if (!accountId) continue;
      await client.request(`/api/m3u/refresh/${accountId}/`, { method: "POST" });
      refreshActions.push({ type: "m3u-refresh", sourceId: source.id, id: accountId, name: source.name });
    }
    if (epgId) {
      await client.request("/api/epg/import/", { method: "POST", body: { id: epgId, force: true } });
      refreshActions.push({ type: "epg-refresh", id: epgId, name: JUSTONE_EPG_NAME });
    }
  }

  const safeActions = applied;
  return {
    apply: true,
    refresh,
    counts: safeActions.reduce((acc, row) => ((acc[`${row.type}:${row.action}`] = (acc[`${row.type}:${row.action}`] || 0) + 1), acc), {}),
    actions: safeActions,
    refreshActions,
    note: refresh ? "Dispatcharr refresh jobs were queued asynchronously. Run channel preview after Dispatcharr has finished importing the M3Us/EPG." : undefined,
  };
}

function changed(existing, desired) {
  const scalar = ["name", "channel_number", "channel_group_id", "tvg_id", "logo_id"];
  for (const key of scalar) {
    if ((existing[key] ?? null) !== (desired[key] ?? null)) return true;
  }
  const a = existing.streams || [];
  const b = desired.streams || [];
  return a.length !== b.length || a.some((value, index) => value !== b[index]);
}

async function ensureGroup(client, groups, name, apply) {
  const existing = groups.find((group) => group.name === name);
  if (existing) return existing.id;
  if (!apply) return `NEW:${name}`;
  const created = await client.request("/api/channels/groups/", { method: "POST", body: { name } });
  groups.push(created);
  return created.id;
}

async function ensureLogo(client, logos, channel, apply) {
  if (!config.dispatcharr.syncLogos || !channel.logo) return null;
  const existing = logos.find((logo) => logo.url === channel.logo);
  if (existing) return existing.id;
  if (!apply) return `NEW:${channel.logo}`;
  const created = await client.request("/api/channels/logos/", {
    method: "POST",
    body: { name: `JustOne - ${channel.name}`.slice(0, 255), url: channel.logo },
  });
  logos.push(created);
  return created.id;
}

export async function reconcileDispatcharr(snapshot, { apply = false, client = new DispatcharrClient() } = {}) {
  if (apply && !config.dispatcharr.applyEnabled) {
    throw new Error("Dispatcharr apply is disabled. Set DISPATCHARR_APPLY_ENABLED=true after reviewing preview output.");
  }

  const [channels, streams, groups, logos] = await Promise.all([
    client.list("/api/channels/channels/"),
    client.list("/api/channels/streams/?tvg_id=justone.&hide_stale=true"),
    client.list("/api/channels/groups/"),
    config.dispatcharr.syncLogos ? client.list("/api/channels/logos/") : Promise.resolve([]),
  ]);

  const managed = channels.filter((ch) => String(ch.tvg_id || "").startsWith("justone."));
  const byTvg = new Map();
  for (const ch of managed) {
    const arr = byTvg.get(ch.tvg_id) || [];
    arr.push(ch);
    byTvg.set(ch.tvg_id, arr);
  }
  const streamsByTvg = new Map();
  for (const stream of streams) {
    if (!String(stream.tvg_id || "").startsWith("justone.")) continue;
    const arr = streamsByTvg.get(stream.tvg_id) || [];
    arr.push(stream);
    streamsByTvg.set(stream.tvg_id, arr);
  }

  const actions = [];
  for (const channel of snapshot.channels || []) {
    const available = [...(streamsByTvg.get(channel.tvgId) || [])]
      .sort((a, b) => rankFromName(a.name) - rankFromName(b.name) || a.id - b.id);
    if (!available.length) {
      actions.push({ action: "waiting-for-streams", tvgId: channel.tvgId, name: channel.name });
      continue;
    }
    const groupId = await ensureGroup(client, groups, channel.group, apply);
    const logoId = await ensureLogo(client, logos, channel, apply);
    const desired = {
      name: channel.name,
      channel_number: Number(channel.number),
      channel_group_id: groupId,
      tvg_id: channel.tvgId,
      streams: available.map((s) => s.id),
      ...(logoId ? { logo_id: logoId } : {}),
    };
    const matches = byTvg.get(channel.tvgId) || [];
    if (matches.length > 1) {
      actions.push({ action: "duplicate-managed-channel", tvgId: channel.tvgId, ids: matches.map((x) => x.id) });
    }
    const existing = matches[0];
    if (!existing) {
      actions.push({ action: "create", tvgId: channel.tvgId, name: channel.name, streams: desired.streams.length });
      if (apply) {
        const created = await client.request("/api/channels/channels/", { method: "POST", body: desired });
        byTvg.set(channel.tvgId, [created]);
      }
      continue;
    }
    if (changed(existing, desired)) {
      actions.push({ action: "update", id: existing.id, tvgId: channel.tvgId, name: channel.name, streams: desired.streams.length });
      if (apply) await client.request(`/api/channels/channels/${existing.id}/`, { method: "PATCH", body: desired });
    } else {
      actions.push({ action: "unchanged", id: existing.id, tvgId: channel.tvgId, name: channel.name, streams: desired.streams.length });
    }
  }

  const desiredIds = new Set((snapshot.channels || []).map((ch) => ch.tvgId));
  for (const ch of managed) {
    if (!desiredIds.has(ch.tvg_id)) actions.push({ action: "orphan", id: ch.id, tvgId: ch.tvg_id, name: ch.name });
  }

  return {
    apply,
    counts: actions.reduce((acc, row) => ((acc[row.action] = (acc[row.action] || 0) + 1), acc), {}),
    actions,
  };
}

export { rankFromName };
