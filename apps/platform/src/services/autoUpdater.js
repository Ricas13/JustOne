import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PREFIX = "[provider-updater]";

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function envNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const settings = {
  enabled: envBool("AUTO_UPDATE_ENABLED", true),
  intervalHours: envNumber("AUTO_UPDATE_INTERVAL_HOURS", 24, 0.25),
  startupDelayMs: envNumber("AUTO_UPDATE_STARTUP_DELAY_MS", 15000, 0),
  gitTimeoutMs: envNumber("AUTO_UPDATE_GIT_TIMEOUT_MS", 30000, 1000),
  buildTimeoutMs: envNumber("AUTO_UPDATE_BUILD_TIMEOUT_MS", 20 * 60 * 1000, 10000),
  upTimeoutMs: envNumber("AUTO_UPDATE_UP_TIMEOUT_MS", 2 * 60 * 1000, 10000),
  projectDir: process.env.AUTO_UPDATE_PROJECT_DIR || "/workspace",
  composeFile: process.env.AUTO_UPDATE_COMPOSE_FILE || "/workspace/docker-compose.yml",
  composeEnvFile: process.env.AUTO_UPDATE_COMPOSE_ENV_FILE || "/workspace/.env",
  composeProject:
    process.env.AUTO_UPDATE_COMPOSE_PROJECT || process.env.COMPOSE_PROJECT_NAME || "justone",
  stateDir: process.env.AUTO_UPDATE_STATE_DIR || "/var/lib/justone-updater",
};

const providers = [
  {
    key: "primary",
    label: "primary source resolver",
    service: process.env.CINEPRO_COMPOSE_SERVICE || "cinepro",
    dir: process.env.CINEPRO_SOURCE_DIR || "/workspace/providers/cinepro",
  },
  {
    key: "secondary",
    label: "secondary source resolver",
    service: process.env.WEBSTREAMR_MBG_COMPOSE_SERVICE || "webstreamr-mbg",
    dir: process.env.WEBSTREAMR_MBG_SOURCE_DIR || "/workspace/providers/webstreamr-mbg",
  },
];

let activeRun = null;
let lastRun = null;
let nextScheduledAt = null;

function log(level, message) {
  process.stdout.write(`${new Date().toISOString()} ${PREFIX} ${level} ${message}\n`);
}

function redact(text) {
  return String(text || "")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1***:***@")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@");
}

function appendTail(current, chunk, maxBytes = 64 * 1024) {
  const next = current + String(chunk);
  return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
}

function runCommand(
  command,
  args,
  { cwd, timeoutMs = 30000, label = command, uid, gid, env = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    log("INFO", `${label}: running ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd,
      env,
      ...(Number.isInteger(uid) ? { uid } : {}),
      ...(Number.isInteger(gid) ? { gid } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log("WARN", `${label}: timeout after ${timeoutMs}ms; terminating process`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    child.once("error", (error) => {
      finish(() => reject(new Error(`${label}: could not start: ${error.message}`)));
    });

    child.once("close", (code, signal) => {
      finish(() => {
        const elapsed = Date.now() - started;
        if (code === 0 && !timedOut) {
          log("INFO", `${label}: completed in ${elapsed}ms`);
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }

        const detail = redact(
          stderr.trim() || stdout.trim() || `exit=${code} signal=${signal || "none"}`,
        );
        const suffix = timedOut ? `timed out after ${timeoutMs}ms` : `exit code ${code}`;
        reject(new Error(`${label}: ${suffix}${detail ? `: ${detail}` : ""}`));
      });
    });
  });
}

function gitArgs(provider, args) {
  // Bind-mounted repositories can have a different host UID. Scope safe.directory
  // to each command instead of changing global Git configuration in the container.
  return ["-c", `safe.directory=${provider.dir}`, "-C", provider.dir, ...args];
}

async function git(provider, args, label) {
  // The platform container needs root for the Docker socket, but Git should run
  // as the bind-mounted checkout owner so pulls do not create root-owned files
  // on the host.
  const owner = await fs.stat(provider.dir);
  const result = await runCommand("git", gitArgs(provider, args), {
    timeoutMs: settings.gitTimeoutMs,
    label: `${provider.label}: ${label}`,
    uid: owner.uid,
    gid: owner.gid,
    env: { ...process.env, HOME: "/tmp" },
  });
  return result.stdout.trim();
}

function pendingFile(provider) {
  return path.join(settings.stateDir, `${provider.key}.pending.json`);
}

async function readPending(provider) {
  try {
    return JSON.parse(await fs.readFile(pendingFile(provider), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePending(provider, data) {
  await fs.mkdir(settings.stateDir, { recursive: true });
  await fs.writeFile(pendingFile(provider), JSON.stringify(data, null, 2), "utf8");
}

async function clearPending(provider) {
  try {
    await fs.unlink(pendingFile(provider));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function composeArgs(args) {
  const out = [
    "compose",
    "-p",
    settings.composeProject,
    "--project-directory",
    settings.projectDir,
  ];
  if (settings.composeEnvFile && (await fileExists(settings.composeEnvFile))) {
    out.push("--env-file", settings.composeEnvFile);
  }
  out.push("-f", settings.composeFile, ...args);
  return out;
}

async function dockerCompose(args, timeoutMs, label) {
  return runCommand("docker", await composeArgs(args), {
    cwd: settings.projectDir,
    timeoutMs,
    label,
  });
}

async function ensureRuntime() {
  if (!(await fileExists(settings.composeFile))) {
    throw new Error(`compose file is missing: ${settings.composeFile}`);
  }
  await fs.mkdir(settings.stateDir, { recursive: true });
}

async function ensureGitRepository(provider) {
  if (!(await fileExists(provider.dir))) {
    throw new Error(`source folder is missing: ${provider.dir}`);
  }
  const inside = await git(provider, ["rev-parse", "--is-inside-work-tree"], "check repository");
  if (inside !== "true") throw new Error(`${provider.dir} is not a Git working tree`);
}

async function updateProvider(provider) {
  const startedAt = Date.now();
  log("INFO", `${provider.label}: checking ${provider.dir}`);
  await ensureGitRepository(provider);

  await git(provider, ["fetch", "origin"], "fetch origin");
  const localSha = await git(provider, ["rev-parse", "HEAD"], "read local revision");
  const remoteSha = await git(provider, ["rev-parse", "@{u}"], "read upstream revision");

  let pending = await readPending(provider);
  let updatedSource = false;
  let finalSha = localSha;

  if (localSha !== remoteSha) {
    log(
      "INFO",
      `${provider.label}: update available ${localSha.slice(0, 12)} -> ${remoteSha.slice(0, 12)}`,
    );

    const trackedChanges = await git(
      provider,
      ["status", "--porcelain", "--untracked-files=no"],
      "check working tree",
    );
    if (trackedChanges) {
      throw new Error("tracked local changes detected; refusing automatic git pull");
    }

    // Fast-forward only: an automated updater must never invent merge commits.
    await git(provider, ["pull", "--ff-only"], "pull update");
    finalSha = await git(provider, ["rev-parse", "HEAD"], "verify updated revision");
    updatedSource = true;

    // Persist before building. If Docker fails, a later run will retry even though
    // the Git checkout already equals its upstream revision.
    pending = {
      service: provider.service,
      from: localSha,
      to: finalSha,
      pulledAt: new Date().toISOString(),
    };
    await writePending(provider, pending);
  } else {
    log("INFO", `${provider.label}: source already current at ${localSha.slice(0, 12)}`);
  }

  if (!updatedSource && !pending) {
    return {
      provider: provider.key,
      service: provider.service,
      updated: false,
      rebuilt: false,
      revision: localSha,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (pending && !updatedSource) {
    log("WARN", `${provider.label}: retrying previously failed/pending rebuild`);
  }

  await dockerCompose(
    ["build", provider.service],
    settings.buildTimeoutMs,
    `${provider.label}: docker build`,
  );
  await dockerCompose(
    ["up", "-d", "--no-deps", provider.service],
    settings.upTimeoutMs,
    `${provider.label}: docker restart`,
  );

  await clearPending(provider);
  log("INFO", `${provider.label}: deployment complete at ${finalSha.slice(0, 12)}`);

  return {
    provider: provider.key,
    service: provider.service,
    updated: updatedSource,
    rebuilt: true,
    revision: finalSha,
    elapsedMs: Date.now() - startedAt,
  };
}

async function performUpdateRun(reason, runId) {
  const startedAt = new Date().toISOString();
  log("INFO", `run ${runId}: starting (${reason})`);
  const results = [];

  try {
    await ensureRuntime();
    // Sequential builds avoid competing for CPU/RAM/disk on the media host.
    for (const provider of providers) {
      try {
        results.push({ ok: true, ...(await updateProvider(provider)) });
      } catch (error) {
        log("ERROR", `${provider.label}: ${redact(error?.message || error)}`);
        results.push({
          ok: false,
          provider: provider.key,
          service: provider.service,
          error: redact(error?.message || String(error)),
        });
      }
    }
  } catch (error) {
    log("ERROR", `run ${runId}: updater runtime failure: ${redact(error?.message || error)}`);
  }

  lastRun = {
    id: runId,
    reason,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
  log("INFO", `run ${runId}: finished`);
  return lastRun;
}

export function triggerProviderUpdate(reason = "manual") {
  if (activeRun) {
    return { started: false, reason: "already-running", runId: activeRun.id };
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const promise = performUpdateRun(reason, runId)
    .catch((error) => {
      log("ERROR", `run ${runId}: unexpected failure: ${redact(error?.message || error)}`);
    })
    .finally(() => {
      if (activeRun?.id === runId) activeRun = null;
    });

  activeRun = {
    id: runId,
    reason,
    startedAt: new Date().toISOString(),
    promise,
  };
  return { started: true, runId, reason };
}

export function getAutoUpdaterStatus() {
  return {
    enabled: settings.enabled,
    running: Boolean(activeRun),
    currentRun: activeRun
      ? { id: activeRun.id, reason: activeRun.reason, startedAt: activeRun.startedAt }
      : null,
    intervalHours: settings.intervalHours,
    nextScheduledAt,
    lastRun,
  };
}

export function startAutoUpdater() {
  if (!settings.enabled) {
    log("INFO", "automatic provider updates are disabled");
    return;
  }

  const intervalMs = settings.intervalHours * 60 * 60 * 1000;
  log("INFO", `enabled; checking every ${settings.intervalHours}h`);

  const startupTimer = setTimeout(() => triggerProviderUpdate("startup"), settings.startupDelayMs);
  startupTimer.unref?.();

  nextScheduledAt = new Date(Date.now() + intervalMs).toISOString();
  const intervalTimer = setInterval(() => {
    nextScheduledAt = new Date(Date.now() + intervalMs).toISOString();
    const result = triggerProviderUpdate("scheduled");
    if (!result.started) {
      log("WARN", "scheduled check skipped because another update run is active");
    }
  }, intervalMs);
  intervalTimer.unref?.();
}
