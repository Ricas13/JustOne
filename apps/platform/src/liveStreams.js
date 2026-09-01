const active = new Map();
let sequence = 0;

const INTERNAL_PROBE_UA = /JustOne Jellyfin Event Selector/i;

function clean(value, max = 120) {
  return String(value || "").replace(/[\r\n]/g, " ").trim().slice(0, max);
}

export function beginLiveStream({ channelId, provider = "", userAgent = "", now = Date.now() } = {}) {
  // The Jellyfin event selector intentionally opens the exact .ts route long
  // enough to prove media bytes exist. It is a health probe, not a viewer, so
  // do not let those short-lived FFmpeg probes inflate the dashboard count.
  if (INTERNAL_PROBE_UA.test(String(userAgent || ""))) {
    return { tracked: false, end() {} };
  }

  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  const id = `${Number(now).toString(36)}-${sequence.toString(36)}`;
  const row = {
    id,
    channelId: clean(channelId, 80),
    provider: clean(provider, 80),
    startedAt: Number(now),
  };
  active.set(id, row);

  let ended = false;
  return {
    id,
    tracked: true,
    end() {
      if (ended) return false;
      ended = true;
      return active.delete(id);
    },
  };
}

export function activeStreamStats(now = Date.now()) {
  const current = Number(now);
  const streams = [...active.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((row) => ({
      id: row.id,
      channelId: row.channelId,
      provider: row.provider,
      startedAt: new Date(row.startedAt).toISOString(),
      durationSeconds: Math.max(0, Math.floor((current - row.startedAt) / 1000)),
    }));

  return {
    active: streams.length,
    uniqueChannels: new Set(streams.map((row) => row.channelId).filter(Boolean)).size,
    streams,
  };
}

export function clearActiveStreams() {
  active.clear();
  sequence = 0;
}
