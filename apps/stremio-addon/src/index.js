import stremioSdk from "stremio-addon-sdk";

const { addonBuilder, serveHTTP } = stremioSdk;

const PORT = Number(process.env.PORT || 7000);
const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:8080").replace(/\/$/, "");
const CINEPRO_URL = (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, "");
const DLHD_URL = (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const manifest = {
  id: "com.justone.addon",
  version: "0.1.1",
  name: "JustOne",
  description:
    "Personal hub: live TV via dlhd-web. For VOD, also use CinePro native /stremio/manifest.json. Not for public hosting.",
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
      return { metas: metas.slice(0, 500) };
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
    let name = `Channel ${channelId}`;
    try {
      const r = await fetch(`${DLHD_URL}/api/channels`, {
        signal: AbortSignal.timeout(10000),
      });
      const channels = await r.json();
      const list = Array.isArray(channels) ? channels : channels.channels || [];
      const found = list.find((c) => String(c.id) === String(channelId));
      if (found?.name) name = found.name;
    } catch {
      /* ignore */
    }
    return {
      meta: {
        id,
        type: "tv",
        name,
        description: "Live channel via JustOne / dlhd-web",
      },
    };
  }
  return { meta: null };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type === "tv" && id.startsWith("justone_live_")) {
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
  return { streams: [] };
});

const iface = builder.getInterface();
serveHTTP(iface, { port: PORT });
console.log(`JustOne Stremio addon on :${PORT}`);
console.log(`  platform: ${PLATFORM_URL}`);
console.log(`  dlhd: ${DLHD_URL}`);
console.log(`  install: http://0.0.0.0:${PORT}/manifest.json`);
console.log(`  VOD: use CinePro at ${CINEPRO_URL}/stremio/manifest.json`);
