import { config } from "./config.js";
import { text, timeoutSignal } from "./util.js";

function rankFromName(name) {
  const match = /\[JO:(\d+)\]/i.exec(String(name || ""));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
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
