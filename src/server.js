import http from "node:http";
import { config, withPublicKey } from "./config.js";
import { refreshCatalog } from "./catalog.js";
import { buildM3u } from "./m3u.js";
import { reconcileDispatcharr } from "./dispatcharr.js";
import { loadGuide, loadSnapshot, loadState, newId, saveState } from "./store.js";
import { json, readJsonBody, text } from "./util.js";
import { ADMIN_HTML } from "./ui.js";

function publicAllowed(url) {
  return !config.publicKey || url.searchParams.get("key") === config.publicKey;
}

function adminAllowed(req) {
  if (!config.adminKey) return true;
  return req.headers.authorization === `Bearer ${config.adminKey}` || req.headers["x-admin-key"] === config.adminKey;
}

function sendText(res, status, body, contentType) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": data.length,
    "cache-control": "no-store",
  });
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

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        return json(res, 200, {
          name: "JustOne Catalog",
          purpose: "IPTV metadata/catalogue + Dispatcharr reconciliation; never proxies video",
          endpoints: ["/health", "/m3u/master.m3u", "/m3u/source/:id.m3u", "/epg/guide.xml", "/api/catalog"],
        });
      }
      if (req.method === "GET" && path === "/admin") {
        return sendText(res, 200, ADMIN_HTML, "text/html; charset=utf-8");
      }
      if (req.method === "GET" && path === "/health") {
        const snapshot = await loadSnapshot();
        return json(res, 200, { ok: true, generatedAt: snapshot.generatedAt, channels: snapshot.channels.length });
      }

      if (req.method === "GET" && path === "/m3u/master.m3u") {
        if (!publicAllowed(url)) return json(res, 401, { error: "invalid key" });
        const snapshot = await loadSnapshot();
        const guide = withPublicKey(`${config.publicUrl}/epg/guide.xml`);
        return sendText(res, 200, buildM3u(snapshot, { publicGuideUrl: guide }), "audio/x-mpegurl; charset=utf-8");
      }
      const sourceMatch = /^\/m3u\/source\/([^/]+)\.m3u$/.exec(path);
      if (req.method === "GET" && sourceMatch) {
        if (!publicAllowed(url)) return json(res, 401, { error: "invalid key" });
        const snapshot = await loadSnapshot();
        const guide = withPublicKey(`${config.publicUrl}/epg/guide.xml`);
        return sendText(res, 200, buildM3u(snapshot, { sourceId: decodeURIComponent(sourceMatch[1]), publicGuideUrl: guide }), "audio/x-mpegurl; charset=utf-8");
      }
      if (req.method === "GET" && path === "/epg/guide.xml") {
        if (!publicAllowed(url)) return json(res, 401, { error: "invalid key" });
        return sendText(res, 200, await loadGuide(), "application/xml; charset=utf-8");
      }

      if (path.startsWith("/api/") && !adminAllowed(req)) return json(res, 401, { error: "admin authentication required" });

      if (req.method === "GET" && path === "/api/state") return json(res, 200, await loadState());
      if (req.method === "GET" && path === "/api/catalog") return json(res, 200, await loadSnapshot());
      if (req.method === "POST" && path === "/api/refresh") return json(res, 200, await refreshCatalog());

      if (req.method === "GET" && path === "/api/sources") return json(res, 200, (await loadState()).sources);
      if (req.method === "POST" && path === "/api/sources") return await updateCollection(req, res, "sources", "src");
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
          await saveState(state);
          return json(res, 200, removed);
        }
        const body = await readJsonBody(req);
        state[collection][index] = { ...state[collection][index], ...body, id };
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
