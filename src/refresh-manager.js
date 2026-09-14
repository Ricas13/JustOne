import { refreshCatalog } from "./catalog.js";
import { augmentGuideWithEvents, finalizeSnapshot } from "./finalize.js";
import { loadGuide, loadState, saveGuide, saveSnapshot } from "./store.js";

function now() { return new Date().toISOString(); }

export function createRefreshManager(runRefresh = refreshCatalog) {
  let currentPromise = null;
  let status = {
    running: false,
    id: null,
    reason: null,
    sourceMode: null,
    phase: "idle",
    currentSource: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    summary: null,
  };

  function snapshot() {
    return structuredClone(status);
  }

  function updateProgress(progress = {}) {
    const hasCurrentSource = Object.prototype.hasOwnProperty.call(progress, "currentSource");
    status = {
      ...status,
      phase: progress.phase || status.phase,
      currentSource: hasCurrentSource ? progress.currentSource : status.currentSource,
      progress: { ...(status.progress || {}), ...progress },
    };
  }

  function start(reason = "manual", options = {}) {
    if (currentPromise) return { started: false, status: snapshot() };

    const sourceMode = options.sourceMode || "auto";
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    status = {
      running: true,
      id,
      reason,
      sourceMode,
      phase: "starting",
      currentSource: null,
      startedAt: now(),
      finishedAt: null,
      lastError: null,
      summary: null,
      progress: {},
    };

    console.log(`[refresh ${id}] started (${reason}; sourceMode=${sourceMode})`);
    currentPromise = (async () => {
      try {
        const raw = await runRefresh({ onProgress: updateProgress, ...options, sourceMode });
        const state = await loadState();
        const finalized = finalizeSnapshot(raw, state);
        const result = finalized.snapshot;

        if (finalized.addedEvents.length) {
          const guide = augmentGuideWithEvents(await loadGuide(), finalized.addedEvents);
          await saveGuide(guide);
          console.log(`[refresh ${id}] linked-channel fallback added ${finalized.addedEvents.length} playable DLHD event(s)`);
        }
        await saveSnapshot(result);

        const staticChannels = (result.channels || []).filter((x) => x.referenceKind !== "event").length;
        const events = (result.channels || []).filter((x) => x.referenceKind === "event").length;
        status = {
          ...status,
          running: false,
          phase: "complete",
          currentSource: null,
          finishedAt: now(),
          summary: {
            channels: result.channels?.length || 0,
            staticChannels,
            events,
            sourceMode: result.sourceMode || sourceMode,
            matchedReferences: result.dlhdStatus?.matchedReferences ?? null,
            totalReferences: result.dlhdStatus?.totalReferences ?? null,
            linkedChannelFallbackEvents: result.dlhdStatus?.linkedChannelFallbackEvents ?? 0,
          },
        };
        console.log(`[refresh ${id}] complete: ${staticChannels} static channels + ${events} events = ${result.channels?.length || 0} outputs`);
      } catch (error) {
        status = {
          ...status,
          running: false,
          phase: "failed",
          currentSource: null,
          finishedAt: now(),
          lastError: error?.message || String(error),
        };
        console.error(`[refresh ${id}] failed:`, error);
      } finally {
        currentPromise = null;
      }
    })();

    return { started: true, status: snapshot() };
  }

  return {
    start,
    status: snapshot,
    wait: () => currentPromise,
  };
}

export const refreshManager = createRefreshManager();
