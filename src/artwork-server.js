import http from "node:http";
import { config } from "./config.js";
import { eventArtworkPng } from "./artwork.js";
import { loadSnapshot } from "./store.js";

function allowed(req, url) {
  if (!config.internalKey) return true;
  return url.searchParams.get("key") === config.internalKey || req.headers["x-internal-key"] === config.internalKey;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

export function createArtworkServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (!allowed(req, url)) return sendJson(res, 401, { error: "invalid internal key" });
      if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, scope: "event-artwork" });

      const match = /^\/artwork\/event\/(channel|program)\/([^/]+)\.png$/.exec(url.pathname);
      if (req.method !== "GET" || !match) return sendJson(res, 404, { error: "not found" });

      const variant = match[1];
      const token = decodeURIComponent(match[2]);
      const snapshot = await loadSnapshot();
      const channel = (snapshot.channels || []).find((row) =>
        row.referenceKind === "event" && (String(row.id) === token || String(row.tvgId) === token)
      );
      if (!channel) return sendJson(res, 404, { error: "event not found" });

      const png = eventArtworkPng(channel, variant);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "public, max-age=21600",
        "x-justone": "event-artwork",
      });
      res.end(png);
    } catch (error) {
      console.error("Event artwork error:", error);
      sendJson(res, 500, { error: error.message });
    }
  });
}
