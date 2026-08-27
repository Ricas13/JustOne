import stremioSdk from "stremio-addon-sdk";

const { addonBuilder, serveHTTP } = stremioSdk;

const PORT = Number(process.env.PORT || 7000);
const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:8080").replace(/\/$/, "");
const CINEPRO_URL = (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, "");
const DLHD_URL = (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, "");
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

const manifest = {
  id: "com.justone.addon",
  version: "1.0.0",
  name: "JustOne",
  description: "Personal hub: movies, series, and live TV. Not for public hosting.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  catalogs: [
    {
      type: "movie",
      id: "justone-movies",
      name: "JustOne Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "justone-series",
      name: "JustOne Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    },
    {
      type: "tv",
      id: "justone-live",
      name: "JustOne Live TV",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
  idPrefixes: ["tmdb:", "justone_live_"],
  behaviorHints: { configurable: false, configurationRequired: false },
};

const builder = new addonBuilder(manifest);

async function tmdb(pathname, params = {}) {
  if (!TMDB_KEY) return null;
  const url = new URL(TMDB + pathname);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) return null;
  return r.json();
}

function movieMeta(m) {
  return {
    id: `tmdb:${m.id}`,
    type: "movie",
    name: m.title,
    poster: m.poster_path ? IMG + m.poster_path : undefined,
    background: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : undefined,
    releaseInfo: (m.release_date || "").slice(0, 4),
    description: m.overview,
  };
}

function seriesMeta(m) {
  return {
    id: `tmdb:${m.id}`,
    type: "series",
    name: m.name,
    poster: m.poster_path ? IMG + m.poster_path : undefined,
    background: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : undefined,
    releaseInfo: (m.first_air_date || "").slice(0, 4),
    description: m.overview,
  };
}

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
      if (q) metas = metas.filter((m) => m.name.toLowerCase().includes(q));
      return { metas: metas.slice(0, 500) };
    } catch (e) {
      console.error("catalog live error", e);
      return { metas: [] };
    }
  }

  const q = extra?.search;
  const page = Math.floor(Number(extra?.skip || 0) / 20) + 1;
  if (type === "movie" && id === "justone-movies") {
    const data = q
      ? await tmdb("/search/movie", { query: q, page })
      : await tmdb("/trending/movie/week", { page });
    return { metas: (data?.results || []).map(movieMeta) };
  }
  if (type === "series" && id === "justone-series") {
    const data = q
      ? await tmdb("/search/tv", { query: q, page })
      : await tmdb("/trending/tv/week", { page });
    return { metas: (data?.results || []).map(seriesMeta) };
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
        description: "Live channel via JustOne",
      },
    };
  }

  if (!id.startsWith("tmdb:")) return { meta: null };
  const tmdbId = id.slice(5);
  if (type === "movie") {
    const m = await tmdb(`/movie/${tmdbId}`);
    if (!m) return { meta: null };
    return { meta: movieMeta(m) };
  }
  if (type === "series") {
    const m = await tmdb(`/tv/${tmdbId}`);
    if (!m) return { meta: null };
    const meta = seriesMeta(m);
    meta.videos = (m.seasons || [])
      .filter((s) => s.season_number > 0)
      .slice(0, 8)
      .flatMap((s) =>
        Array.from({ length: Math.min(s.episode_count || 0, 24) }, (_, i) => ({
          id: `tmdb:${tmdbId}:${s.season_number}:${i + 1}`,
          title: `S${String(s.season_number).padStart(2, "0")}E${String(i + 1).padStart(2, "0")}`,
          season: s.season_number,
          episode: i + 1,
        })),
      );
    return { meta };
  }
  return { meta: null };
});

function extractSources(data) {
  if (!data) return [];
  if (Array.isArray(data.sources)) return data.sources;
  if (Array.isArray(data.streams)) return data.streams;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function sourceUrl(s) {
  if (!s) return null;
  if (typeof s === "string") return s;
  return s.url || s.src || s.stream || s.file || null;
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type === "tv" && id.startsWith("justone_live_")) {
    const channelId = id.replace("justone_live_", "");
    return {
      streams: [
        {
          name: "JustOne Live",
          title: "Live",
          url: `${PLATFORM_URL}/proxy/live/${channelId}`,
        },
      ],
    };
  }

  if (!id.startsWith("tmdb:")) return { streams: [] };
  const parts = id.slice(5).split(":");
  const tmdbId = parts[0];
  try {
    let path;
    if (type === "movie") path = `${CINEPRO_URL}/v1/movies/${tmdbId}`;
    else if (type === "series" && parts.length >= 3) {
      path = `${CINEPRO_URL}/v1/tv/${tmdbId}/seasons/${parts[1]}/episodes/${parts[2]}`;
    } else {
      return { streams: [] };
    }
    const r = await fetch(path, { signal: AbortSignal.timeout(90000) });
    const data = await r.json();
    const streams = extractSources(data)
      .map((s, i) => {
        const url = sourceUrl(s);
        if (!url) return null;
        return {
          name: s.provider || s.name || `Source ${i + 1}`,
          title: s.quality || s.title || "JustOne",
          url: `${PLATFORM_URL}/proxy/vod?url=${encodeURIComponent(url)}`,
        };
      })
      .filter(Boolean)
      .slice(0, 20);
    return { streams };
  } catch (e) {
    console.error("stream error", e);
    return { streams: [] };
  }
});

const iface = builder.getInterface();
serveHTTP(iface, { port: PORT });
console.log(`JustOne Stremio addon on :${PORT}`);
console.log(`  install: ${PLATFORM_URL}/stremio-live/manifest.json`);
console.log(`  or CinePro native: ${CINEPRO_URL}/stremio/manifest.json`);
