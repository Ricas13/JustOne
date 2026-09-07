import fs from "node:fs";
import path from "node:path";

const WARM_INTERVAL_MS = Math.max(3000, Math.min(120_000, Number(process.env.LIVE_SOURCE_WARM_INTERVAL_MS || 10_000)));
const SWITCH_MARGIN = Math.max(1, Math.min(50, Number(process.env.LIVE_SOURCE_SWITCH_MARGIN || 12)));
const SWITCH_COOLDOWN_MS = Math.max(0, Math.min(10 * 60_000, Number(process.env.LIVE_SOURCE_SWITCH_COOLDOWN_MS || 30_000)));
const SWITCH_CONFIRMATIONS = Math.max(1, Math.min(12, Number(process.env.LIVE_SOURCE_SWITCH_CONFIRMATIONS || 3)));
const FAILURE_THRESHOLD = Math.max(1, Math.min(10, Number(process.env.LIVE_SOURCE_FAILURE_THRESHOLD || 2)));
const STANDBY_FRESH_MS = Math.max(WARM_INTERVAL_MS, Math.min(10 * 60_000, Number(process.env.LIVE_SOURCE_STANDBY_FRESH_MS || 30_000)));
const HISTORY_SAVE_DELAY_MS = Math.max(1000, Math.min(60_000, Number(process.env.LIVE_SOURCE_HISTORY_SAVE_DELAY_MS || 5000)));
const HISTORY_MAX_AGE_MS = Math.max(60_000, Math.min(90 * 24 * 60 * 60_000, Number(process.env.LIVE_SOURCE_HISTORY_MAX_AGE_MS || 14 * 24 * 60 * 60_000)));
const HISTORY_PREFERENCE_MAX_AGE_MS = Math.max(60_000, Math.min(HISTORY_MAX_AGE_MS, Number(process.env.LIVE_SOURCE_HISTORY_PREFERENCE_MAX_AGE_MS || 24 * 60 * 60_000)));
const MAX_PARALLEL_PROBES = Math.max(1, Math.min(8, Number(process.env.LIVE_SOURCE_MAX_PARALLEL_PROBES || 4)));
const FULL_SCAN_EVERY = Math.max(1, Math.min(12, Number(process.env.LIVE_SOURCE_FULL_SCAN_EVERY || 3)));
const FALLBACK_SCAN_EVERY = Math.max(FULL_SCAN_EVERY, Math.min(120, Number(process.env.LIVE_SOURCE_FALLBACK_SCAN_EVERY || 12)));
const HISTORY_PATH = String(process.env.LIVE_SOURCE_HISTORY_PATH || (process.env.PATH_LIVE ? path.join(process.env.PATH_LIVE, ".live-source-history.json") : "")).trim();

const managers = new Map();
const history = new Map();
let historyLoaded = false;
let saveTimer = null;

function log(...args) { process.stdout.write(args.map(String).join(" ") + "\n"); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function historyKey(channelId, endpoint) { return JSON.stringify([String(channelId || ""), String(endpoint?.provider || "unknown"), String(endpoint?.url || "")]); }
function managerKey(channelId, endpoints) { return JSON.stringify([String(channelId || ""), ...(endpoints || []).map((endpoint) => [String(endpoint.provider || ""), String(endpoint.url || "")])]); }
function endpointKey(endpoint) { return endpoint ? `${String(endpoint.provider || "")}\n${String(endpoint.url || "")}` : ""; }
function isExactDaddyEndpoint(endpoint) { return /^daddy:/i.test(String(endpoint?.provider || "")); }

function blankHealth(channelId, endpoint) {
  return { channelId: String(channelId || ""), provider: String(endpoint?.provider || "unknown"), url: String(endpoint?.url || ""), successes: 0, failures: 0, consecutiveSuccesses: 0, consecutiveFailures: 0, ewmaLatencyMs: 0, lastSuccessAt: 0, lastFailureAt: 0, lastStatus: null, selectedCount: 0 };
}

function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  if (!HISTORY_PATH) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    const now = Date.now();
    for (const row of Array.isArray(parsed?.sources) ? parsed.sources : []) {
      if (!row?.channelId || !row?.url) continue;
      const lastSeen = Math.max(Number(row.lastSuccessAt || 0), Number(row.lastFailureAt || 0));
      if (lastSeen && now - lastSeen > HISTORY_MAX_AGE_MS) continue;
      const endpoint = { provider: row.provider || "unknown", url: row.url };
      history.set(historyKey(row.channelId, endpoint), {
        ...blankHealth(row.channelId, endpoint),
        successes: Math.max(0, Number(row.successes || 0)), failures: Math.max(0, Number(row.failures || 0)),
        consecutiveSuccesses: Math.max(0, Number(row.consecutiveSuccesses || 0)), consecutiveFailures: Math.max(0, Number(row.consecutiveFailures || 0)),
        ewmaLatencyMs: Math.max(0, Number(row.ewmaLatencyMs || 0)), lastSuccessAt: Math.max(0, Number(row.lastSuccessAt || 0)), lastFailureAt: Math.max(0, Number(row.lastFailureAt || 0)),
        lastStatus: row.lastStatus == null ? null : Number(row.lastStatus), selectedCount: Math.max(0, Number(row.selectedCount || 0)),
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") log("live source manager", `history-load-failed=${error?.message || error}`);
  }
}

function pruneHistory(now = Date.now()) {
  for (const [key, row] of history) {
    const lastSeen = Math.max(row.lastSuccessAt || 0, row.lastFailureAt || 0);
    if (lastSeen && now - lastSeen > HISTORY_MAX_AGE_MS) history.delete(key);
  }
}

function persistableRows() {
  pruneHistory();
  return [...history.values()].map((row) => ({ ...row, ewmaLatencyMs: Math.round(row.ewmaLatencyMs || 0) }));
}

function saveHistoryNow() {
  saveTimer = null;
  if (!HISTORY_PATH) return;
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const tmp = `${HISTORY_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 2, updatedAt: Date.now(), sources: persistableRows() }, null, 2)}\n`);
    fs.renameSync(tmp, HISTORY_PATH);
  } catch (error) { log("live source manager", `history-save-failed=${error?.message || error}`); }
}

function scheduleHistorySave() {
  if (!HISTORY_PATH || saveTimer) return;
  saveTimer = setTimeout(saveHistoryNow, HISTORY_SAVE_DELAY_MS);
  saveTimer.unref?.();
}

function healthFor(channelId, endpoint) {
  loadHistory();
  const key = historyKey(channelId, endpoint);
  let row = history.get(key);
  if (!row) { row = blankHealth(channelId, endpoint); history.set(key, row); }
  return row;
}

function scoreHealth(row, now = Date.now()) {
  const total = row.successes + row.failures;
  const successRate = total > 0 ? row.successes / total : 0.5;
  const successStreak = Math.min(15, row.consecutiveSuccesses * 3);
  const failurePenalty = Math.min(40, row.consecutiveFailures * 14);
  const latencyPenalty = row.ewmaLatencyMs > 0 ? Math.min(15, row.ewmaLatencyMs / 200) : 0;
  const recentSuccess = row.lastSuccessAt && now - row.lastSuccessAt <= STANDBY_FRESH_MS ? 8 : 0;
  const recentFailure = row.lastFailureAt && now - row.lastFailureAt <= STANDBY_FRESH_MS ? 12 : 0;
  const experience = Math.min(8, Math.log2(total + 1) * 2);
  const selectedMemory = Math.min(4, Math.log2(row.selectedCount + 1));
  const lastSeen = Math.max(row.lastSuccessAt || 0, row.lastFailureAt || 0);
  const agePenalty = lastSeen ? Math.min(20, ((now - lastSeen) / HISTORY_MAX_AGE_MS) * 20) : 0;
  return clamp(40 + successRate * 35 + successStreak + experience + selectedMemory + recentSuccess - failurePenalty - latencyPenalty - recentFailure - agePenalty, 0, 100);
}

function record(channelId, endpoint, { ok, latencyMs = 0, status = null } = {}) {
  const row = healthFor(channelId, endpoint);
  if (ok) {
    row.successes += 1; row.consecutiveSuccesses += 1; row.consecutiveFailures = 0; row.lastSuccessAt = Date.now();
    const sample = Math.max(0, Number(latencyMs || 0));
    if (sample > 0) row.ewmaLatencyMs = row.ewmaLatencyMs > 0 ? row.ewmaLatencyMs * 0.75 + sample * 0.25 : sample;
  } else {
    row.failures += 1; row.consecutiveFailures += 1; row.consecutiveSuccesses = 0; row.lastFailureAt = Date.now();
  }
  row.lastStatus = status == null ? null : Number(status);
  scheduleHistorySave();
  return row;
}

function selectedEndpoint(manager) {
  return manager.endpoints.find((endpoint) => endpoint.provider === manager.selectedProvider && endpoint.url === manager.selectedUrl) || null;
}

function resetChallenger(manager) {
  manager.challengerKey = "";
  manager.challengerWins = 0;
}

function noteChallengerWin(manager, endpoint) {
  const key = endpointKey(endpoint);
  if (manager.challengerKey === key) manager.challengerWins += 1;
  else {
    manager.challengerKey = key;
    manager.challengerWins = 1;
  }
  return manager.challengerWins;
}

function restoreHistoricalSelection(manager) {
  const now = Date.now();
  const ranked = manager.endpoints
    .map((endpoint) => ({ endpoint, health: healthFor(manager.channelId, endpoint) }))
    .filter(({ health }) => health.lastSuccessAt && now - health.lastSuccessAt <= HISTORY_PREFERENCE_MAX_AGE_MS && health.consecutiveFailures < FAILURE_THRESHOLD)
    .sort((a, b) => {
      const exact = Number(isExactDaddyEndpoint(b.endpoint)) - Number(isExactDaddyEndpoint(a.endpoint));
      return exact || scoreHealth(b.health, now) - scoreHealth(a.health, now);
    });
  if (!ranked.length) return;
  manager.selectedProvider = ranked[0].endpoint.provider;
  manager.selectedUrl = ranked[0].endpoint.url;
  resetChallenger(manager);
}

function getManager(channelId, endpoints, probe) {
  const key = managerKey(channelId, endpoints);
  let manager = managers.get(key);
  if (!manager) {
    manager = { key, channelId: String(channelId || ""), endpoints: [...(endpoints || [])], probe, selectedProvider: "", selectedUrl: "", lastSwitchAt: 0, activeRefs: 0, monitorTimer: null, monitorInFlight: null, lastQualificationAt: 0, monitorTicks: 0, challengerKey: "", challengerWins: 0 };
    restoreHistoricalSelection(manager);
    managers.set(key, manager);
  } else {
    manager.endpoints = [...(endpoints || [])];
    if (probe) manager.probe = probe;
    if (!selectedEndpoint(manager)) restoreHistoricalSelection(manager);
  }
  return manager;
}

function choose(manager, successfulEndpoints, { force = false } = {}) {
  if (!successfulEndpoints.length) return selectedEndpoint(manager);
  const now = Date.now();
  const ranked = successfulEndpoints.map((endpoint) => ({ endpoint, score: scoreHealth(healthFor(manager.channelId, endpoint), now) })).sort((a, b) => {
    const exact = Number(isExactDaddyEndpoint(b.endpoint)) - Number(isExactDaddyEndpoint(a.endpoint));
    return exact || b.score - a.score;
  });
  const best = ranked[0];
  const current = selectedEndpoint(manager);
  const currentSuccess = current ? ranked.find((row) => row.endpoint.provider === current.provider && row.endpoint.url === current.url) : null;
  let next = current || best.endpoint;

  if (!current) {
    next = best.endpoint;
    resetChallenger(manager);
  } else if (!currentSuccess) {
    const currentHealth = healthFor(manager.channelId, current);
    if (force || currentHealth.consecutiveFailures >= FAILURE_THRESHOLD) {
      next = best.endpoint;
      resetChallenger(manager);
    }
  } else {
    const challengerIsDifferent = best.endpoint.url !== current.url || best.endpoint.provider !== current.provider;
    const exactUpgrade = challengerIsDifferent && isExactDaddyEndpoint(best.endpoint) && !isExactDaddyEndpoint(current);
    const materiallyBetter = challengerIsDifferent && (exactUpgrade || best.score >= currentSuccess.score + SWITCH_MARGIN);
    const cooldownPassed = now - manager.lastSwitchAt >= SWITCH_COOLDOWN_MS;
    if (materiallyBetter && cooldownPassed) {
      if (force || noteChallengerWin(manager, best.endpoint) >= SWITCH_CONFIRMATIONS) {
        next = best.endpoint;
        resetChallenger(manager);
      }
    } else {
      resetChallenger(manager);
    }
  }

  if (!current || next.url !== current.url || next.provider !== current.provider) {
    manager.selectedProvider = next.provider; manager.selectedUrl = next.url; manager.lastSwitchAt = now;
    const health = healthFor(manager.channelId, next); health.selectedCount += 1; scheduleHistorySave();
    log("live source manager", `channel=${manager.channelId}`, `selected=${next.provider}`, `score=${scoreHealth(health, now).toFixed(1)}`, current ? `previous=${current.provider}` : "previous=none");
  }
  return selectedEndpoint(manager);
}

async function probeOne(manager, endpoint) {
  const startedAt = Date.now();
  try {
    await manager.probe(endpoint);
    record(manager.channelId, endpoint, { ok: true, latencyMs: Date.now() - startedAt, status: 200 });
    return { endpoint, ok: true };
  } catch (error) {
    record(manager.channelId, endpoint, { ok: false, latencyMs: Date.now() - startedAt, status: error?.status ?? null });
    return { endpoint, ok: false, error };
  }
}

async function probeMany(manager, endpoints) {
  const queue = [...endpoints];
  const results = [];
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_PROBES, queue.length) }, async () => {
    while (queue.length) {
      const endpoint = queue.shift();
      if (!endpoint) break;
      results.push(await probeOne(manager, endpoint));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function qualifyLiveSources(channelId, endpoints, probe, { force = false } = {}) {
  const manager = getManager(channelId, endpoints, probe);
  const results = await probeMany(manager, manager.endpoints);
  manager.lastQualificationAt = Date.now();
  const successes = results.filter((row) => row.ok).map((row) => row.endpoint);
  const selected = choose(manager, successes, { force });
  if (selected && successes.some((endpoint) => endpoint.url === selected.url)) return selected;
  const lastError = [...results].reverse().find((row) => row.error)?.error;
  throw lastError || new Error("no healthy live source candidates");
}

export function preferredLiveSource(channelId, endpoints, probe, { maxAgeMs = 0 } = {}) {
  const manager = getManager(channelId, endpoints, probe);
  const endpoint = selectedEndpoint(manager);
  if (!endpoint) return null;
  const health = healthFor(channelId, endpoint);
  if (!health.lastSuccessAt) return null;
  if (maxAgeMs > 0 && Date.now() - health.lastSuccessAt > maxAgeMs) return null;
  if (health.consecutiveFailures >= FAILURE_THRESHOLD) return null;
  return endpoint;
}

function rankedEndpoints(manager) {
  const now = Date.now();
  return [...manager.endpoints].sort((a, b) => {
    const exact = Number(isExactDaddyEndpoint(b)) - Number(isExactDaddyEndpoint(a));
    return exact || scoreHealth(healthFor(manager.channelId, b), now) - scoreHealth(healthFor(manager.channelId, a), now);
  });
}

function recentlyHealthy(manager, endpoint, now = Date.now()) {
  const health = healthFor(manager.channelId, endpoint);
  return Boolean(health.lastSuccessAt && now - health.lastSuccessAt <= STANDBY_FRESH_MS && health.consecutiveFailures < FAILURE_THRESHOLD);
}

function warmProbeTargets(manager, ranked, current) {
  const now = Date.now();
  const exact = ranked.filter(isExactDaddyEndpoint);
  const healthyExact = exact.filter((endpoint) => recentlyHealthy(manager, endpoint, now));

  // Only suppress aggregate/legacy probing once we genuinely have redundancy
  // inside the exact media-validated Daddy candidate set. With fewer than two
  // healthy exact candidates, preserve the old broad warm-standby behaviour.
  if (healthyExact.length < 2) {
    if (manager.monitorTicks % FULL_SCAN_EVERY === 0) return ranked;
    const standby = ranked.find((endpoint) => !current || endpoint.url !== current.url);
    return [current, standby].filter(Boolean);
  }

  const targets = [];
  const add = (endpoint) => {
    if (!endpoint) return;
    if (!targets.some((row) => row.provider === endpoint.provider && row.url === endpoint.url)) targets.push(endpoint);
  };

  // If the historical/current winner is still an aggregate or legacy source,
  // keep observing it only while exact candidates earn the normal confirmation
  // count needed to replace it. Once selected is exact, normal warm traffic is
  // confined to exact candidates.
  if (!current || isExactDaddyEndpoint(current)) add(current);
  else add(current);

  const exactStandby = healthyExact.find((endpoint) => !current || endpoint.url !== current.url)
    || exact.find((endpoint) => !current || endpoint.url !== current.url);
  add(exactStandby);

  if (manager.monitorTicks % FULL_SCAN_EVERY === 0) {
    for (const endpoint of exact) add(endpoint);
  }

  // Aggregate and legacy routes remain available as tertiary recovery paths,
  // but probing one of them every two minutes is enough when two exact sources
  // are already warm. Initial/forced qualification still probes every endpoint.
  if (manager.monitorTicks % FALLBACK_SCAN_EVERY === 0) {
    add(ranked.find((endpoint) => !isExactDaddyEndpoint(endpoint)));
  }
  return targets;
}

async function monitorCycle(manager) {
  if (manager.monitorInFlight || !manager.activeRefs || !manager.probe) return;
  manager.monitorInFlight = (async () => {
    manager.monitorTicks += 1;
    const ranked = rankedEndpoints(manager);
    const current = selectedEndpoint(manager);
    const targets = warmProbeTargets(manager, ranked, current);
    const results = await probeMany(manager, targets);
    manager.lastQualificationAt = Date.now();
    const successes = results.filter((row) => row.ok).map((row) => row.endpoint);
    choose(manager, successes, { force: false });
  })().catch((error) => {
    log("live source manager", `channel=${manager.channelId}`, `warm-monitor-failed=${error?.message || error}`);
  }).finally(() => { manager.monitorInFlight = null; });
  await manager.monitorInFlight;
}

function startMonitor(manager) {
  if (manager.monitorTimer || !manager.activeRefs) return;
  void monitorCycle(manager);
  manager.monitorTimer = setInterval(() => { void monitorCycle(manager); }, WARM_INTERVAL_MS);
  manager.monitorTimer.unref?.();
}

function stopMonitor(manager) {
  if (!manager.monitorTimer) return;
  clearInterval(manager.monitorTimer); manager.monitorTimer = null;
}

export function retainLiveSourceLearning(channelId, endpoints, probe) {
  const manager = getManager(channelId, endpoints, probe);
  manager.activeRefs += 1; startMonitor(manager);
  return () => { manager.activeRefs = Math.max(0, manager.activeRefs - 1); if (!manager.activeRefs) stopMonitor(manager); };
}

function managersForObservation(channelId, rootUrl) {
  const id = String(channelId || ""); const url = String(rootUrl || "");
  return [...managers.values()].filter((manager) => manager.channelId === id && manager.endpoints.some((endpoint) => endpoint.url === url));
}

export function noteLiveSourceObservation(channelId, rootUrl, { ok, latencyMs = 0, status = null } = {}) {
  for (const manager of managersForObservation(channelId, rootUrl)) {
    const endpoint = manager.endpoints.find((candidate) => candidate.url === String(rootUrl || ""));
    if (!endpoint) continue;
    const row = record(channelId, endpoint, { ok, latencyMs, status });
    if (!ok && row.consecutiveFailures >= FAILURE_THRESHOLD) {
      const warm = rankedEndpoints(manager).filter((candidate) => candidate.url !== endpoint.url && healthFor(channelId, candidate).lastSuccessAt && Date.now() - healthFor(channelId, candidate).lastSuccessAt <= STANDBY_FRESH_MS);
      if (warm.length) choose(manager, warm, { force: true });
    }
  }
}

export function liveSourceManagerStats(now = Date.now()) {
  loadHistory();
  return {
    warmIntervalMs: WARM_INTERVAL_MS, switchMargin: SWITCH_MARGIN, switchCooldownMs: SWITCH_COOLDOWN_MS, switchConfirmations: SWITCH_CONFIRMATIONS,
    failureThreshold: FAILURE_THRESHOLD, standbyFreshMs: STANDBY_FRESH_MS, maxParallelProbes: MAX_PARALLEL_PROBES,
    fullScanEvery: FULL_SCAN_EVERY, fallbackScanEvery: FALLBACK_SCAN_EVERY, historyMaxAgeMs: HISTORY_MAX_AGE_MS, historyPath: HISTORY_PATH || null, historyRecords: history.size,
    managers: [...managers.values()].map((manager) => ({
      channelId: manager.channelId, activeRefs: manager.activeRefs, selectedProvider: manager.selectedProvider || null,
      challengerProvider: manager.challengerKey ? manager.challengerKey.split("\n", 1)[0] : null, challengerWins: manager.challengerWins,
      lastQualificationAt: manager.lastQualificationAt ? new Date(manager.lastQualificationAt).toISOString() : null,
      candidates: manager.endpoints.map((endpoint) => {
        const row = healthFor(manager.channelId, endpoint);
        return { provider: endpoint.provider, url: endpoint.url, score: Number(scoreHealth(row, now).toFixed(1)), successes: row.successes, failures: row.failures, consecutiveSuccesses: row.consecutiveSuccesses, consecutiveFailures: row.consecutiveFailures, latencyMs: Math.round(row.ewmaLatencyMs || 0), lastSuccessAt: row.lastSuccessAt ? new Date(row.lastSuccessAt).toISOString() : null, lastFailureAt: row.lastFailureAt ? new Date(row.lastFailureAt).toISOString() : null, selected: endpoint.url === manager.selectedUrl && endpoint.provider === manager.selectedProvider };
      }).sort((a, b) => b.score - a.score),
    })),
  };
}

export function resetLiveSourceManagerForTests() {
  for (const manager of managers.values()) stopMonitor(manager);
  managers.clear(); history.clear(); historyLoaded = true;
  if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
}
