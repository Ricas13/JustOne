import { config } from "../config.js";
import { resolveMovie, resolveEpisode } from "../resolve.js";
import { fetchMovieStreams, fetchEpisodeStreams } from "./webStreamrClient.js";

function extractSources(data) {
  if (!data) return [];
  if (Array.isArray(data.sources)) return data.sources;
  if (Array.isArray(data.streams)) return data.streams;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

export function advertisedQuality(source) {
  if (!source) return "unknown";
  const raw = typeof source === "string" ? source : JSON.stringify(source);
  const text = String(raw || "").toLowerCase();
  if (/\b2160p?\b|\b4k\b|\buhd\b|3840\s*[x×]\s*2160/.test(text)) return "4k";
  if (/\b1080p?\b|1920\s*[x×]\s*1080/.test(text)) return "1080p";
  if (/\b720p?\b|1280\s*[x×]\s*720/.test(text)) return "720p";
  if (/\b(?:480|360|240)p?\b/.test(text)) return "sd";
  return "unknown";
}

function withBudget(call) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("source resolver timed out")),
      config.sourceProviderTimeoutMs,
    );
    timer.unref?.();
    Promise.resolve()
      .then(call)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

async function primaryRequest(pathname) {
  const response = await fetch(`${config.cineproUrl}${pathname}`, {
    signal: AbortSignal.timeout(config.sourceProviderTimeoutMs),
  });
  if (!response.ok) throw new Error(`primary resolver returned ${response.status}`);
  return response.json();
}

async function inspect(primaryCall, secondaryCall) {
  const [primary, secondary] = await Promise.allSettled([
    withBudget(primaryCall),
    withBudget(secondaryCall),
  ]);

  const primaryRows = primary.status === "fulfilled" ? extractSources(primary.value) : [];
  const secondaryRows = secondary.status === "fulfilled" ? secondary.value || [] : [];
  const rows = [...primaryRows, ...secondaryRows];
  const qualities = [...new Set(rows.map(advertisedQuality))];
  const has4k = qualities.includes("4k");
  const hasNon4k = qualities.some((quality) => quality !== "4k");
  const complete = primary.status === "fulfilled" && secondary.status === "fulfilled";

  return {
    complete,
    has4k,
    hasNon4k,
    hasAny: rows.length > 0,
    qualities,
    sources: rows.length,
    providerErrors: {
      primary:
        primary.status === "rejected"
          ? String(primary.reason?.message || primary.reason)
          : null,
      secondary:
        secondary.status === "rejected"
          ? String(secondary.reason?.message || secondary.reason)
          : null,
    },
  };
}

function playable4kResult(picked) {
  if (picked?.url && picked.quality === "4k" && picked.matched && picked.validated) {
    return {
      state: "available",
      resolver: picked.resolver || null,
      provider: picked.provider || null,
    };
  }

  const providerErrors = picked?.providerErrors || {};
  if (providerErrors.primary || providerErrors.secondary) {
    return {
      state: "indeterminate",
      reason: "provider-error",
      providerErrors,
    };
  }

  return {
    state: "unavailable",
    reason: "no-working-4k-source",
    available: picked?.available || [],
  };
}

export function inspectMovieQualities(tmdbId) {
  return inspect(
    () => primaryRequest(`/v1/movies/${tmdbId}`),
    () => fetchMovieStreams(tmdbId),
  );
}

export function inspectEpisodeQualities(tmdbId, season, episode) {
  return inspect(
    () => primaryRequest(`/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`),
    () => fetchEpisodeStreams(tmdbId, season, episode),
  );
}

export async function validateMovie4k(tmdbId) {
  try {
    return playable4kResult(await resolveMovie(tmdbId, "4k"));
  } catch (error) {
    return {
      state: "indeterminate",
      reason: "resolver-error",
      error: String(error?.message || error),
    };
  }
}

export async function validateEpisode4k(tmdbId, season, episode) {
  try {
    return playable4kResult(await resolveEpisode(tmdbId, season, episode, "4k"));
  } catch (error) {
    return {
      state: "indeterminate",
      reason: "resolver-error",
      error: String(error?.message || error),
    };
  }
}
