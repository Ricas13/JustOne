import { config } from "../config.js";

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function requestHeaders(stream) {
  const raw = stream?.behaviorHints?.proxyHeaders?.request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => [String(key), String(value)]),
  );
}

function normalizeStream(stream) {
  if (!stream || !isHttpUrl(stream.url)) return null;
  return {
    url: String(stream.url),
    // Keep provider-specific fields opaque; the shared resolver derives quality
    // from this object using the same rules as the existing source resolver.
    quality: stream.quality || stream.resolution || "",
    name: stream.name || "",
    title: stream.title || "",
    type: stream.type || "",
    requestHeaders: requestHeaders(stream),
    provider: "secondary",
    raw: stream,
  };
}

async function fetchStreams(type, id) {
  const endpoint = `${config.streamProviderUrl}/stream/${type}/${encodeURIComponent(id)}.json`;
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      "user-agent": "JustOne source resolver",
    },
    signal: AbortSignal.timeout(config.sourceProviderTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`stream provider returned ${response.status}`);
  }

  const data = await response.json();
  return (Array.isArray(data?.streams) ? data.streams : [])
    .map(normalizeStream)
    .filter(Boolean);
}

export function fetchMovieStreams(tmdbId) {
  return fetchStreams("movie", `tmdb:${tmdbId}`);
}

export function fetchEpisodeStreams(tmdbId, season, episode) {
  return fetchStreams("series", `tmdb:${tmdbId}:${season}:${episode}`);
}
