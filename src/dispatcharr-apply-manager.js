import { reconcileDispatcharr } from "./dispatcharr-epg.js";

function now() {
  return new Date().toISOString();
}

export function createDispatcharrApplyManager(runApply = reconcileDispatcharr) {
  let currentPromise = null;
  let status = {
    running: false,
    id: null,
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    lastError: null,
    result: null,
  };

  function snapshot() {
    return structuredClone(status);
  }

  function start(snapshotToApply) {
    if (currentPromise) return { started: false, status: snapshot() };

    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    status = {
      running: true,
      id,
      phase: "applying",
      startedAt: now(),
      finishedAt: null,
      lastError: null,
      result: null,
    };

    console.log(`[dispatcharr ${id}] reconciliation started`);
    currentPromise = (async () => {
      try {
        const result = await runApply(snapshotToApply, { apply: true });
        status = {
          ...status,
          running: false,
          phase: "complete",
          finishedAt: now(),
          result: {
            counts: result?.counts || {},
            note: result?.note || "Dispatcharr catalogue reconciliation applied.",
          },
        };
        console.log(`[dispatcharr ${id}] reconciliation complete`);
      } catch (error) {
        status = {
          ...status,
          running: false,
          phase: "failed",
          finishedAt: now(),
          lastError: error?.message || String(error),
        };
        console.error(`[dispatcharr ${id}] reconciliation failed:`, error);
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

export const dispatcharrApplyManager = createDispatcharrApplyManager();
