import express from "express";
import stremioSdk from "stremio-addon-sdk";

const { addonBuilder, getRouter } = stremioSdk;

const PORT = Number(process.env.PORT || 7000);
const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:8080").replace(/\/$/, "");
const DLHD_URL = (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, "");
const PLAYLIST_KEY = process.env.PLAYLIST_KEY || "";

const manifest = {
  id: "com.justone.addon",
  version: "1.1.0",
  name: "JustOne Live TV",
  description: "JustOne Live TV channels backed by the same validated live resolver used by Jellyfin.",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "justone-live",
      name: "JustOne Live TV",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
  idPrefixes: ["justone_live_"],
};

const builder = new addonBuilder(manifest);

function platformUrl(pathname) {
  const url = new URL(pathname, `${PLATFORM_URL}/`);
  url.searchParams.set("format", "json");
  if (PLAYLIST_KEY) url.searchParams.set("key", PLAYLIST_KEY);
  return url.href;
}

async function resolvedUrl(pathname) {
  try {
    const response = await fetch(platformUrl(pathname), {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.url || null;
  } catch {
    return null;
  }
}

async function channels() {
  try {
    const response = await fetch(`${DLHD_URL}/api/channels`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : data.channels || [];
  } catch {
    return [];
  }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "tv" || id !== "justone-live") return { metas: [] };
  let metas = (await channels()).map((channel) => ({
    id: `justone_live_${channel.id}`,
    type: "tv",
    name: channel.name || `Channel ${channel.id}`,
    genres: ["Live"],
  }));
  const query = String(extra?.search || "").toLowerCase();
  if (query) metas = metas.filter((meta) => meta.name.toLowerCase().includes(query));
  return { metas: metas.slice(0, 500) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("justone_live_")) return { meta: null };
  const channelId = id.replace("justone_live_", "");
  const channel = (await channels()).find((item) => String(item.id) === channelId);
  return {
    meta: {
      id,
      type: "tv",
      name: channel?.name || `Channel ${channelId}`,
      genres: ["Live"],
    },
  };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "tv" || !id.startsWith("justone_live_")) return { streams: [] };
  const channelId = id.replace("justone_live_", "");
  const url = await resolvedUrl(`/resolve/live/${encodeURIComponent(channelId)}`);
  return { streams: url ? [{ name: "JustOne Live", url }] : [] };
});

const app = express();
const router = getRouter(builder.getInterface());
app.use("/", router);
app.use("/stremio", router);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`JustOne Live TV Stremio addon on :${PORT} (/ and /stremio)`);
});
