import { addonBuilder, serveHTTP } from "stremio-addon-sdk";

const PORT = Number(process.env.PORT || 7000);
const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:8080").replace(/\/$/, "");
const CINEPRO_URL = (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, "");
const DLHD_URL = (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const manifest = {
  id: "com.justone.addon",
  version: "0.1.0",
  name: "JustOne",
  description:
    "Personal hub: movies/series via CinePro + live TV via dlhd-web. Not for public hosting.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  catalogs: [
    {
      type: "tv",
      id: "justone-live",
      name: "JustOne Live TV",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
  idPrefixes: ["justone_live_", "tt", "tmdb:"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type === "tv" && id === "justone-live") {
    try {
      const r = await fetch(`${DLHD_URL}/api/channels`, {
        signal: AbortSignal.timeout(15000),
      });
      const channels = await r.json();
      const list = Array.isArray(channels) ? channels : channels.channels || [];
      let metas = list.map((ch) => ({
        id: `justone_live_${ch.id}`,
        type: "tv",
        name: ch.name || `Channel ${ch.id}`,
        poster: ch.logo || undefined,
        genres: ["Live"],
      }));
      const q = (extra?.search || "").toLowerCase();
      if (q) {
        metas = metas.filter((m) => m.name.toLowerCase().includes(q));
      }
      return { metas: metas.slice(0, 200) };
    } catch (e) {
      console.error("catalog live error", e);
      return { metas: [] };
    }
  }
  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type === "tv" && id.startsWith("justone_live_")) {
    const channelId = id.replace("justone_live_", "");
    return {
      meta: {
        id,
        type: "tv",
        name: `Channel ${channelId}`,
        description: "Live channel via JustOne / dlhd-web",
      },
    };
  }
  return { meta: null };
});

builder.defineStreamHandler(async ({ type, id }) => {
  // Live channels
  if (id.startsWith("justone_live_")) {
    const channelId = id.replace("justone_live_", "");
    return {
      streams: [
        {
          name: "JustOne Live",
          title: "Proxy → dlhd",
          url: `${PLATFORM_URL}/proxy/live/${channelId}`,
        },
      ],
    };
  }

  // IMDb-style ids — forward to CinePro if it exposes streams; best-effort
  if (type === "movie" || type === "series") {
    try {
      // Prefer CinePro native Stremio if enabled on Core
      const cineManifest = `${CINEPRO_URL}/stremio/manifest.json`;
      // Fallback: empty and let users also install CinePro native addon
      void cineManifest;
      return { streams: [] };
    } catch {
      return { streams: [] };
    }
  }

  return { streams: [] };
});

const interface_ = builder.getInterface();
serveHTTP(interface_, { port: PORT });
console.log(`JustOne Stremio addon on :${PORT}`);
console.log(`  platform: ${PLATFORM_URL}`);
console.log(`  install: ${PUBLIC_URL.replace(/:\d+$/, ":" + PORT)}/manifest.json`);
