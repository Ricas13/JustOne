import { config } from "./config.js";
import { DispatcharrClient, provisionDispatcharrInputs } from "./dispatcharr.js";
import { reconcileDispatcharr } from "./dispatcharr-epg.js";
import { loadSnapshot, loadState } from "./store.js";

function now() {
  return new Date().toISOString();
}

function propsOf(row) {
  const value = row?.custom_properties;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function isManagedM3u(row) {
  const props = propsOf(row);
  return props.justone_managed === true && props.justone_role === "filtered_m3u";
}

function isManagedEpg(row) {
  const props = propsOf(row);
  return props.justone_managed === true && props.justone_role === "canonical_epg";
}

function stamp(row) {
  return String(row?.updated_at || "");
}

function terminalStatus(value) {
  return !["fetching", "parsing", "pending_setup"].includes(String(value || "").toLowerCase());
}

function failedStatus(value) {
  return String(value || "").toLowerCase() === "error";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDispatcharrAutoSyncManager({
  makeClient = () => new DispatcharrClient(),
  loadCurrentState = loadState,
  loadCurrentSnapshot = loadSnapshot,
  provision = provisionDispatcharrInputs,
  reconcile = reconcileDispatcharr,
  settings = config.dispatcharr,
  sleepFn = sleep,
} = {}) {
  let currentPromise = null;
  let pendingReason = null;
  let status = {
    running: false,
    id: null,
    reason: null,
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    lastError: null,
    result: null,
  };

  function snapshotStatus() {
    return structuredClone(status);
  }

  async function managedRows(client) {
    const [accounts, epgSources] = await Promise.all([
      client.list("/api/m3u/accounts/"),
      client.list("/api/epg/sources/"),
    ]);
    return {
      accounts: accounts.filter(isManagedM3u),
      epgSources: epgSources.filter(isManagedEpg),
    };
  }

  function start(reason = "catalog-refresh") {
    if (currentPromise) {
      pendingReason = reason;
      return { started: false, queued: true, status: snapshotStatus() };
    }
    if (!settings.url || !settings.applyEnabled || settings.autoSyncEnabled === false) {
      return {
        started: false,
        status: {
          ...snapshotStatus(),
          phase: "disabled",
          lastError: !settings.url
            ? "DISPATCHARR_URL is not configured"
            : !settings.applyEnabled
              ? "DISPATCHARR_APPLY_ENABLED=false"
              : "DISPATCHARR_AUTO_SYNC_ENABLED=false",
        },
      };
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    status = {
      running: true,
      id,
      reason,
      phase: "provisioning",
      startedAt: now(),
      finishedAt: null,
      lastError: null,
      result: null,
    };

    currentPromise = (async () => {
      const client = makeClient();
      try {
        const before = await managedRows(client);
        const beforeM3u = new Map(before.accounts.map((row) => [String(row.id), {
          stamp: stamp(row),
          status: String(row.status || "").toLowerCase(),
        }]));
        const beforeEpg = new Map(before.epgSources.map((row) => [String(row.id), {
          stamp: stamp(row),
          status: String(row.status || "").toLowerCase(),
        }]));

        const state = await loadCurrentState();
        status = { ...status, phase: "queueing-imports" };
        const provisioned = await provision(state, { apply: true, refresh: true, client });

        status = { ...status, phase: "waiting-for-imports" };
        const deadline = Date.now() + Math.max(1, Number(settings.autoSyncTimeoutMinutes || 15)) * 60 * 1000;
        const pollMs = Math.max(1000, Number(settings.autoSyncPollSeconds || 5) * 1000);
        const advancedInputs = new Set();
        let imports = null;

        while (Date.now() < deadline) {
          await sleepFn(pollMs);
          const current = await managedRows(client);
          const taggedRows = [
            ...current.accounts.map((row) => ({ kind: "m3u", row, baseline: beforeM3u })),
            ...current.epgSources.map((row) => ({ kind: "epg", row, baseline: beforeEpg })),
          ];
          const rows = taggedRows.map(({ row }) => row);

          for (const { kind, row, baseline } of taggedRows) {
            const key = `${kind}:${row.id}`;
            const beforeRow = baseline.get(String(row.id));
            const currentStatus = String(row.status || "").toLowerCase();
            const advanced = !beforeRow
              ? Boolean(stamp(row)) || !terminalStatus(currentStatus)
              : stamp(row) !== beforeRow.stamp || currentStatus !== beforeRow.status;
            if (advanced) advancedInputs.add(key);
          }

          const errors = taggedRows
            .filter(({ kind, row }) => failedStatus(row.status) && advancedInputs.has(`${kind}:${row.id}`))
            .map(({ row }) => row);
          if (errors.length) {
            throw new Error(
              `Dispatcharr import failed: ${errors.map((row) => `${row.name || row.id}: ${row.last_message || row.status}`).join("; ")}`
            );
          }

          const allTerminal = rows.length > 0 && rows.every((row) => terminalStatus(row.status));
          const allAdvanced = taggedRows.length > 0
            && taggedRows.every(({ kind, row }) => advancedInputs.has(`${kind}:${row.id}`));

          if (allTerminal && allAdvanced) {
            imports = current;
            break;
          }
        }

        if (!imports) {
          throw new Error(
            `Timed out waiting ${settings.autoSyncTimeoutMinutes || 15} minute(s) for Dispatcharr M3U/EPG imports to finish`
          );
        }

        status = { ...status, phase: "previewing" };
        const catalogue = await loadCurrentSnapshot();
        const preview = await reconcile(catalogue, { apply: false, client });
        if (!preview.readyForApply) {
          throw new Error(
            `Dispatcharr reconciliation not ready after import: ${(preview.blockers || []).join("; ") || "preview blocked"}`
          );
        }

        status = { ...status, phase: "reconciling" };
        const applied = await reconcile(catalogue, { apply: true, client });

        status = {
          ...status,
          running: false,
          phase: "complete",
          finishedAt: now(),
          result: {
            provisionCounts: provisioned?.counts || {},
            reconciliationCounts: applied?.counts || {},
            note: applied?.note || "Dispatcharr inputs and channel catalogue synchronized.",
          },
        };
        console.log(`[dispatcharr-auto ${id}] complete after ${reason}`);
      } catch (error) {
        status = {
          ...status,
          running: false,
          phase: "failed",
          finishedAt: now(),
          lastError: error?.message || String(error),
        };
        console.error(`[dispatcharr-auto ${id}] failed after ${reason}:`, error);
      } finally {
        currentPromise = null;
        if (pendingReason) {
          const nextReason = pendingReason;
          pendingReason = null;
          queueMicrotask(() => start(nextReason));
        }
      }
    })();

    return { started: true, queued: false, status: snapshotStatus() };
  }

  return {
    start,
    status: snapshotStatus,
    wait: () => currentPromise,
  };
}

export const dispatcharrAutoSyncManager = createDispatcharrAutoSyncManager();
