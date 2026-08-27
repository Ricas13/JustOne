import stremioSdk from "stremio-addon-sdk";

const { addonBuilder, serveHTTP } = stremioSdk;

const PORT = Number(process.env.PORT || 7000);
const PLATFORM_URL = (process.env.PLATFORM_URL || "http://localhost:8080").replace(/\/$/, "");
const DLHD_URL = (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, "");
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

const manifest = {
  id: "com.justone.addon",
  version: "1.0.0",
  name: "JustOne",
  description:
    "Movies, series, live TV. Resolver returns a direct stream URL — video does not transit JustOne.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series", "tv"],
  catalogs: [
    { type: "movie", id: "justone-movies", name: "JustOne Movies", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "justone-series", name: "JustOne Series", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "tv", id: "justone-live", name: "JustOne Live TV", extra: [{ name: "search", isRequired: false }] },
  ],
  idPrefixes: ["tmdb:", "justone_live_"],
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
    description: m.overview,
    releaseInfo: (m.release_date || "").slice(0, 4),
  };
}

function seriesMeta(m) {
  return {
    id: `tmdb:${m.id}`,
    type: "series",
    name: m.name,
    poster: m.poster_path ? IMG + m.poster_path : undefined,
    description: m.overview,
    releaseInfo: (m.first_air_date || "").slice(0, 4),
  };
}

async function resolvedUrl(pathname) {
  const r = await fetch(`${PLATFORM_URL}${pathname}${pathname.includes("?") ? "&" : "?"}format=json`, {
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.url || null;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type === "tv" && id === "justone-live") {
    try {
      const r = await fetch(`${DLHD_URL}/api/channels`, { signal: AbortSignal.timeout(15000) });
      const channels = await r.json();
      const list = Array.isArray(channels) ? channels : channels.channels || [];
      let metas = list.map((ch) => ({
        id: `justone_live_${ch.id}`,
        type: "tv",
        name: ch.name || `Channel ${ch.id}`,
        genres: ["Live"],
      }));
      const q = (extra?.search || "").toLowerCase();
      if (q) metas = metas.filter((m) => m.name.toLowerCase().includes(q));
      return { metas: metas.slice(0, 500) };
    } catch {
      return { metas: [] };
    }
  }
  const q = extra?.search;
  const page = Math.floor(Number(extra?.skip || 0) / 20) + 1;
  if (type === "movie") {
    const data = q
      ? await tmdb("/search/movie", { query: q, page })
      : await tmdb("/trending/movie/week", { page });
    return { metas: (data?.results || []).map(movieMeta) };
  }
  if (type === "series") {
    const data = q
      ? await tmdb("/search/tv", { query: q, page })
      : await tmdb("/trending/tv/week", { page });
    return { metas: (data?.results || []).map(seriesMeta) };
  }
  return { metas: [] };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type === "tv" && id.startsWith("justone_live_")) {
    return { meta: { id, type: "tv", name: `Channel ${id.replace("justone_live_", "")}` } };
  }
  if (!id.startsWith("tmdb:")) return { meta: null };
  const tmdbId = id.slice(5).split(":")[0];
  if (type === "movie") {
    const m = await tmdb(`/movie/${tmdbId}`);
    return m ? { meta: movieMeta(m) } : { meta: null };
  }
  if (type === "series") {
    const m = await tmdb(`/tv/${tmdbId}`);
    if (!m) return { meta: null };
    const meta = seriesMeta(m);
    meta.videos = (m.seasons || [])
      .filter((s) => s.season_number > 0)
      .slice(0, 6)
      .flatMap((s) =>
        Array.from({ length: Math.min(s.episode_count || 0, 20) }, (_, i) => ({
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

builder.defineStreamHandler(async ({ type, id }) => {
  if (type === "tv" && id.startsWith("justone_live_")) {
    const channelId = id.replace("justone_live_", "");
    const url = await resolvedUrl(`/resolve/live/${channelId}`);
    return { streams: url ? [{ name: "JustOne Live", url }] : [] };
  }
  if (!id.startsWith("tmdb:")) return { streams: [] };
  const parts = id.slice(5).split(":");
  const tmdbId = parts[0];
  const streams = [];
  if (type === "movie") {
    for (const quality of ["1080p", "4k"]) {
      const url = await resolvedUrl(`/resolve/movie/${tmdbId}?quality=${quality}`);
      if (url) streams.push({ name: `JustOne ${quality}`, title: quality, url });
    }
  } else if (type === "series" && parts.length >= 3) {
    for (const quality of ["1080p", "4k"]) {
      const url = await resolvedUrl(
        `/resolve/episode/${tmdbId}/${parts[1]}/${parts[2]}?quality=${quality}`,
      );
      if (url) streams.push({ name: `JustOne ${quality}`, title: quality, url });
    }
  }
  return { streams };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`JustOne Stremio addon on :${PORT}`);
