import http from "node:http";
import { config, withInternalKey, withStreamProxyKey } from "./config.js";
import { refreshManager } from "./refresh-manager.js";
import { buildM3u } from "./m3u.js";
import { provisionDispatcharrInputs } from "./dispatcharr.js";
import { reconcileDispatcharr } from "./dispatcharr-epg.js";
import { StreamManager } from "./stream-manager.js";
import { loadGuide, loadSnapshot, loadState, newId, saveState } from "./store.js";
import { duplicateSourceByUrl, normaliseSourceInput, parseBulkPlaylistText } from "./sources.js";
import { json, readJsonBody, text } from "./util.js";
import { ADMIN_HTML } from "./ui.js";

export const streamManager = new StreamManager({
  loadSnapshot,
  loadState,
  options: config.streamProxy,
});

function relayUrlForChannel(channel) {
  return withStreamProxyKey(`${config.internalBaseUrl}/stream/${encodeURIComponent(channel.id)}.ts`);
}

function adminAllowed(req) {
  if (!config.adminKey) return true;
  return req.headers.authorization === `Bearer ${config.adminKey}` || req.headers["x-admin-key"] === config.adminKey;
}
function keyAllowed(req, url, key, headerName) {
  if (!key) return true;
  return url.searchParams.get("key") === key || req.headers[headerName] === key;
}
function internalAllowed(req, url) {
  return keyAllowed(req, url, config.internalKey, "x-internal-key");
}
function streamAllowed(req, url) {
  return keyAllowed(req, url, config.streamProxy.key, "x-stream-key");
}
function sendText(res, status, body, contentType) {
  const data = Buffer.from(body);
  res.writeHead(status, { "content-type": contentType, "content-length": data.length, "cache-control": "no-store" });
  res.end(data);
}
async function updateCollection(req, res, collection, idPrefix) {
  const state = await loadState();
  const body = await readJsonBody(req);
  const row = { ...body, id: text(body.id || newId(idPrefix)) };
  if (!row.name || !row.url) return json(res, 400, { error: "name and url are required" });
  state[collection].push(row);
  await saveState(state);
  json(res, 201, row);
}

async function addSource(req, res) {
  const state = await loadState();
  const body = await readJsonBody(req);
  let source;
  try {
    source = normaliseSourceInput(body, state.sources || []);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
  const duplicate = duplicateSourceByUrl(state.sources || [], source.url);
  if (duplicate) return json(res, 409, { error: "playlist already exists", existing: duplicate });
  const row = { ...source, id: text(body.id || newId("src")) };
  state.sources.push(row);
  await saveState(state);
  return json(res, 201, row);
}

async function addSourcesBulk(req, res) {
  const state = await loadState();
  const body = await readJsonBody(req);
  const requested = Array.isArray(body.sources) ? body.sources : parseBulkPlaylistText(body.text || "");
  const added = [];
  const skipped = [];

  for (const input of requested) {
    if (input?.invalid) {
      skipped.push({ input: input.invalid, reason: "not a URL or 'Name | URL' row" });
      continue;
    }
    let source;
    try {
      source = normaliseSourceInput(input, state.sources || []);
    } catch (error) {
      skipped.push({ input: input?.url || input?.name || "", reason: error.message });
      continue;
    }
    const duplicate = duplicateSourceByUrl(state.sources || [], source.url);
    if (duplicate) {
      skipped.push({ input: source.url, reason: `already exists as ${duplicate.name}`, id: duplicate.id });
      continue;
    }
    const row = { ...source, id: newId("src") };
    state.sources.push(row);
    added.push(row);
  }

  if (added.length) await saveState(state);
  return json(res, 200, { added, skipped, counts: { added: added.length, skipped: skipped.length } });
}

export function createAdminServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        return json(res, 200, {
          name: "JustOne Catalog",
          purpose: "Standalone DLHD-filtered IPTV catalogue, account allocator and native stream proxy for Jellyfin; Dispatcharr is legacy rollback only",
          endpoints: ["/health", "/admin", "/api/catalog"],
        });
      }
      if (req.method === "GET" && path === "/health") {
        const snapshot = await loadSnapshot();
        return json(res, 200, {
          ok: true,
          generatedAt: snapshot.generatedAt,
          channels: snapshot.channels.length,
          dlhd: snapshot.dlhdStatus || null,
          refresh: refreshManager.status(),
          streamProxy: { enabled: config.streamProxy.enabled, masterEnabled: config.streamProxy.enabled && config.streamProxy.masterEnabled },
        });
      }
      if (req.method === "GET" && path === "/admin") {
        return sendText(res, 200, ADMIN_HTML, "text/html; charset=utf-8");
      }

      if (path.startsWith("/m3u/") || path.startsWith("/stream/") || path === "/epg/guide.xml") {
        return json(res, 404, { error: "output is available only on the internal listener" });
      }

      if (path.startsWith("/api/") && !adminAllowed(req)) return json(res, 401, { error: "admin authentication required" });
      if (req.method === "GET" && path === "/api/state") return json(res, 200, await loadState());
      if (req.method === "GET" && path === "/api/catalog") return json(res, 200, await loadSnapshot());
      if (req.method === "GET" && path === "/api/streams") {
        const status = await streamManager.status();
        return json(res, 200, {
          enabled: config.streamProxy.enabled,
          masterEnabled: config.streamProxy.enabled && config.streamProxy.masterEnabled,
          ...status,
        });
      }
      if (req.method === "GET" && path === "/api/dlhd") {
        const snap = await loadSnapshot();
        return json(res, 200, { status: snap.dlhdStatus || null, reference: snap.dlhdReference || null });
      }
      if (req.method === "GET" && path === "/api/internal-outputs") {
        const state = await loadState();
        return json(res, 200, {
          guide: withInternalKey(`${config.internalBaseUrl}/epg/guide.xml`),
          master: config.streamProxy.enabled && config.streamProxy.masterEnabled
            ? withStreamProxyKey(`${config.internalBaseUrl}/m3u/master.m3u`)
            : withInternalKey(`${config.internalBaseUrl}/m3u/master.m3u`),
          proxy: config.streamProxy.enabled ? withStreamProxyKey(`${config.internalBaseUrl}/m3u/proxy.m3u`) : null,
          masterMode: config.streamProxy.enabled && config.streamProxy.masterEnabled ? "proxy" : "variants",
          sources: (state.sources || []).filter((s) => s.enabled !== false).map((s) => ({
            id: s.id,
            name: s.name,
            url: withInternalKey(`${config.internalBaseUrl}/m3u/source/${encodeURIComponent(s.id)}.m3u`),
          })),
        });
      }
      if (req.method === "POST" && path === "/api/refresh") {
        const started = refreshManager.start("admin-dlhd", { sourceMode: "cache" });
        return json(res, 202, started);
      }
      if (req.method === "POST" && path === "/api/refresh/providers") {
        const started = refreshManager.start("admin-provider", { sourceMode: "network" });
        return json(res, 202, started);
      }
      if (req.method === "GET" && path === "/api/refresh/status") {
        return json(res, 200, refreshManager.status());
      }
      if (req.method === "GET" && path === "/api/refresh/config") {
        return json(res, 200, {
          providerRefreshMinutes: config.providerRefreshMinutes,
          dlhdRefreshMinutes: config.dlhdRefreshMinutes,
          providerCacheMaxAgeMinutes: config.providerCacheMaxAgeMinutes,
        });
      }

      if (req.method === "GET" && path === "/api/sources") return json(res, 200, (await loadState()).sources);
      if (req.method === "POST" && path === "/api/sources") return await addSource(req, res);
      if (req.method === "POST" && path === "/api/sources/bulk") return await addSourcesBulk(req, res);
      if (req.method === "GET" && path === "/api/guides") return json(res, 200, (await loadState()).guides);
      if (req.method === "POST" && path === "/api/guides") return await updateCollection(req, res, "guides", "epg");

      const resourceMatch = /^\/api\/(sources|guides)\/([^/]+)$/.exec(path);
      if (resourceMatch && ["PATCH", "DELETE"].includes(req.method)) {
        const state = await loadState();
        const collection = resourceMatch[1];
        const id = decodeURIComponent(resourceMatch[2]);
        const index = state[collection].findIndex((row) => row.id === id);
        if (index < 0) return json(res, 404, { error: "not found" });
        if (req.method === "DELETE") {
          const [removed] = state[collection].splice(index, 1);
          if (collection === "guides" && removed.auto === true && removed.sourceId) {
            const source = state.sources.find((row) => row.id === removed.sourceId);
            if (source) source.epgDisabled = true;
          }
          await saveState(state);
          return json(res, 200, removed);
        }
        const body = await readJsonBody(req);
        if (collection === "sources") {
          try {
            const existingOther = state.sources.filter((row) => row.id !== id);
            const merged = normaliseSourceInput({ ...state.sources[index], ...body }, existingOther);
            const duplicate = duplicateSourceByUrl(existingOther, merged.url);
            if (duplicate) return json(res, 409, { error: "playlist URL already belongs to another source", existing: duplicate });
            state.sources[index] = { ...merged, id };
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
        } else {
          state[collection][index] = { ...state[collection][index], ...body, id };
        }
        await saveState(state);
        return json(res, 200, state[collection][index]);
      }

      if (req.method === "PUT" && path === "/api/aliases") {
        const state = await loadState();
        state.aliases = await readJsonBody(req);
        await saveState(state);
        return json(res, 200, state.aliases);
      }
      if (req.method === "PUT" && path === "/api/overrides") {
        const state = await loadState();
        state.overrides = await readJsonBody(req);
        await saveState(state);
        return json(res, 200, state.overrides);
      }

      if (req.method === "GET" && path === "/api/dispatcharr/inputs/preview") {
        return json(res, 200, await provisionDispatcharrInputs(await loadState(), { apply: false }));
      }
      if (req.method === "POST" && path === "/api/dispatcharr/inputs/provision") {
        const body = await readJsonBody(req);
        return json(res, 200, await provisionDispatcharrInputs(await loadState(), {
          apply: body.apply === true,
          refresh: body.refresh !== false,
        }));
      }
      if (req.method === "GET" && path === "/api/dispatcharr/preview") {
        return json(res, 200, await reconcileDispatcharr(await loadSnapshot(), { apply: false }));
      }
      if (req.method === "POST" && path === "/api/dispatcharr/reconcile") {
        const body = await readJsonBody(req);
        return json(res, 200, await reconcileDispatcharr(await loadSnapshot(), { apply: body.apply === true }));
      }

      return json(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: error.message });
    }
  });
}

export function createInternalServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;
      const proxyProtected = path === "/m3u/proxy.m3u"
        || path.startsWith("/stream/")
        || (path === "/m3u/master.m3u" && config.streamProxy.enabled && config.streamProxy.masterEnabled);
      if (proxyProtected) {
        if (!streamAllowed(req, url)) return json(res, 401, { error: "invalid stream proxy key" });
      } else if (!internalAllowed(req, url)) {
        return json(res, 401, { error: "invalid internal key" });
      }
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, {
          ok: true,
          scope: "internal-output",
          streamProxy: {
            enabled: config.streamProxy.enabled,
            masterEnabled: config.streamProxy.enabled && config.streamProxy.masterEnabled,
          },
        });
      }

      if (req.method === "GET" && path === "/m3u/master.m3u") {
        const snapshot = await loadSnapshot();
        const guide = withInternalKey(`${config.internalBaseUrl}/epg/guide.xml`);
        const proxied = config.streamProxy.enabled && config.streamProxy.masterEnabled;
        return sendText(
          res,
          200,
          buildM3u(snapshot, {
            guideUrl: guide,
            ...(proxied ? { streamUrlForChannel: relayUrlForChannel } : {}),
          }),
          "audio/x-mpegurl; charset=utf-8"
        );
      }
      if (req.method === "GET" && path === "/m3u/proxy.m3u") {
        if (!config.streamProxy.enabled) return json(res, 404, { error: "stream proxy is disabled" });
        const snapshot = await loadSnapshot();
        const guide = withInternalKey(`${config.internalBaseUrl}/epg/guide.xml`);
        return sendText(
          res,
          200,
          buildM3u(snapshot, { guideUrl: guide, streamUrlForChannel: relayUrlForChannel }),
          "audio/x-mpegurl; charset=utf-8"
        );
      }
      const sourceMatch = /^\/m3u\/source\/([^/]+)\.m3u$/.exec(path);
      if (req.method === "GET" && sourceMatch) {
        const snapshot = await loadSnapshot();
        const guide = withInternalKey(`${config.internalBaseUrl}/epg/guide.xml`);
        return sendText(res, 200, buildM3u(snapshot, { sourceId: decodeURIComponent(sourceMatch[1]), guideUrl: guide }), "audio/x-mpegurl; charset=utf-8");
      }
      const streamMatch = /^\/stream\/(.+)\.ts$/.exec(path);
      if ((req.method === "GET" || req.method === "HEAD") && streamMatch) {
        if (!config.streamProxy.enabled) return json(res, 404, { error: "stream proxy is disabled" });
        return await streamManager.handle(decodeURIComponent(streamMatch[1]), req, res);
      }
      if (req.method === "GET" && path === "/epg/guide.xml") {
        return sendText(res, 200, await loadGuide(), "application/xml; charset=utf-8");
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: error.message });
    }
  });
}

export const createServer = createAdminServer;
