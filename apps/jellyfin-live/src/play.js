import { spawn } from "node:child_process";

const DEFAULT_STALL_MS = Math.max(0, Number(process.env.JELLYFIN_STREAM_STALL_MS ?? 0));
const DEFAULT_PREBUFFER_MS = Math.max(0, Number(process.env.JELLYFIN_PREBUFFER_MS ?? 0));
const DEFAULT_FFMPEG_RW_TIMEOUT_MS = Math.max(1000, Number(process.env.JELLYFIN_FFMPEG_RW_TIMEOUT_MS ?? 20000));
const DEFAULT_SOURCE_REFRESH_RETRIES = Math.max(
  0,
  Math.min(4, Number(process.env.JELLYFIN_SOURCE_REFRESH_RETRIES ?? 2)),
);
const DEFAULT_SOURCE_REFRESH_BASE_MS = Math.max(
  100,
  Number(process.env.JELLYFIN_SOURCE_REFRESH_BASE_MS ?? 1000),
);
const MAX_SOURCES_PER_CANDIDATE = 6;
const DEFAULT_SOURCES_PER_CANDIDATE = Math.max(
  1,
  Math.min(
    MAX_SOURCES_PER_CANDIDATE,
    Number(process.env.JELLYFIN_SOURCES_PER_CANDIDATE || MAX_SOURCES_PER_CANDIDATE),
  ),
);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function sourceUrl(rawUrl, source, refresh = false) {
  const url = new URL(String(rawUrl));
  url.searchParams.set("source", String(source));
  if (refresh) url.searchParams.set("refresh", "1");
  else url.searchParams.delete("refresh");
  return url.href;
}

export function refreshAttemptUrl(rawUrl) {
  const url = new URL(String(rawUrl));
  url.searchParams.set("refresh", "1");
  return url.href;
}

function normalizeSourcesPerCandidate(value) {
  return Math.max(
    1,
    Math.min(MAX_SOURCES_PER_CANDIDATE, Number(value) || DEFAULT_SOURCES_PER_CANDIDATE),
  );
}

function normalizeDelayMs(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function normalizeRetryCount(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(4, Math.floor(parsed))) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildAttempts(channel, sourcesPerCandidate = DEFAULT_SOURCES_PER_CANDIDATE) {
  const attempts = [];
  const count = normalizeSourcesPerCandidate(sourcesPerCandidate);
  for (const [candidateIndex, candidate] of (channel?.candidates || []).entries()) {
    if (!/^https?:\/\//i.test(String(candidate?.url || ""))) continue;
    for (let source = 0; source < count; source += 1) {
      attempts.push({
        candidateIndex,
        source,
        url: sourceUrl(candidate.url, source),
        label: String(candidate.label || channel?.name || `source ${candidateIndex + 1}`),
      });
    }
  }
  return attempts;
}

export function resultMeansNoMoreSources(result) {
  return Number(result?.bytes || 0) === 0
    && /HTTP error 404 Not Found/i.test(String(result?.detail || ""));
}

export function resultShouldRefreshSource(result) {
  if (!result || result.reason === "client-closed" || resultMeansNoMoreSources(result)) return false;
  if (Number(result.bytes || 0) > 0) return true;

  const detail = String(result.detail || "");
  return /(?:HTTP error (?:400|401|403|408|409|425|429|500|502|503|504)|End of file|Operation timed out|timed out|Failed to reload playlist|Server returned 5XX|Connection (?:reset|refused)|Input\/output error)/i.test(detail);
}

export function ffmpegArgs(url) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "warning",
    "-rw_timeout", String(Math.round(DEFAULT_FFMPEG_RW_TIMEOUT_MS * 1000)),
    "-i", url,
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-c", "copy",
    "-f", "mpegts",
    "-mpegts_flags", "+resend_headers+initial_discontinuity",
    "pipe:1",
  ];
}

function runAttempt(attempt, req, res, { stallMs, prebufferMs, log }) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ffmpegArgs(attempt.url), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let finished = false;
    let bytes = 0;
    let lastDataAt = Date.now();
    let stderr = "";
    let watchdog = null;
    let backpressured = false;
    let bufferTimer = null;
    let bufferedChunks = [];
    let childExit = null;

    const clearBufferTimer = () => {
      if (!bufferTimer) return;
      clearTimeout(bufferTimer);
      bufferTimer = null;
    };

    const finish = (reason, detail = "") => {
      if (finished) return;
      finished = true;
      if (watchdog) clearInterval(watchdog);
      clearBufferTimer();
      bufferedChunks = [];
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolve({ reason, detail, bytes });
    };

    const finishChildExitWhenDrained = () => {
      if (!childExit || bufferedChunks.length || backpressured) return false;
      finish("ffmpeg-exit", childExit.detail);
      return true;
    };

    const scheduleBufferFlush = (delayMs = null) => {
      if (finished || backpressured || bufferTimer || !bufferedChunks.length) return;
      const delay = delayMs ?? Math.max(0, bufferedChunks[0].releaseAt - Date.now());
      bufferTimer = setTimeout(() => {
        bufferTimer = null;
        flushBuffer();
      }, delay);
      bufferTimer.unref?.();
    };

    const writeChunk = (chunk) => {
      if (finished || res.destroyed || req.aborted) {
        finish("client-closed");
        return false;
      }
      if (!res.write(chunk)) {
        backpressured = true;
        child.stdout.pause();
        res.once("drain", () => {
          if (finished) return;
          backpressured = false;
          lastDataAt = Date.now();
          child.stdout?.resume();
          if (!finishChildExitWhenDrained()) scheduleBufferFlush(0);
        });
        return false;
      }
      return true;
    };

    function flushBuffer() {
      if (finished || backpressured) return;
      const now = Date.now();
      while (bufferedChunks.length && bufferedChunks[0].releaseAt <= now) {
        const { chunk } = bufferedChunks.shift();
        if (!writeChunk(chunk)) return;
      }
      if (finishChildExitWhenDrained()) return;
      scheduleBufferFlush();
    }

    child.stdout.on("data", (chunk) => {
      if (finished || res.destroyed || req.aborted) return finish("client-closed");
      lastDataAt = Date.now();
      bytes += chunk.length;

      if (prebufferMs <= 0) {
        writeChunk(chunk);
        return;
      }

      bufferedChunks.push({
        chunk,
        releaseAt: Date.now() + prebufferMs,
      });
      scheduleBufferFlush();
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });

    child.once("error", (error) => finish("spawn-error", String(error.message || error)));
    child.once("close", (code, signal) => {
      childExit = {
        detail: `code=${code ?? "null"} signal=${signal || "none"} ${stderr.trim()}`.trim(),
      };
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (prebufferMs <= 0 || !bufferedChunks.length) {
        finish("ffmpeg-exit", childExit.detail);
        return;
      }
      flushBuffer();
    });

    if (stallMs > 0) {
      watchdog = setInterval(() => {
        if (res.destroyed || req.aborted) return finish("client-closed");
        if (!backpressured && Date.now() - lastDataAt >= stallMs) {
          const phase = bytes ? "stalled" : "no-media";
          log(`${phase}: ${attempt.label} stream ${attempt.source + 1}`);
          finish(phase, `no output for ${stallMs}ms`);
        }
      }, Math.min(1000, Math.max(250, Math.floor(stallMs / 4))));
      watchdog.unref?.();
    }
  });
}

export async function streamSequentially(req, res, channel, options = {}) {
  const stallMs = normalizeDelayMs(options.stallMs, DEFAULT_STALL_MS);
  const prebufferMs = normalizeDelayMs(options.prebufferMs, DEFAULT_PREBUFFER_MS);
  const sourcesPerCandidate = normalizeSourcesPerCandidate(
    options.sourcesPerCandidate || DEFAULT_SOURCES_PER_CANDIDATE,
  );
  const sourceRefreshRetries = normalizeRetryCount(
    options.sourceRefreshRetries,
    DEFAULT_SOURCE_REFRESH_RETRIES,
  );
  const sourceRefreshBaseMs = normalizeDelayMs(
    options.sourceRefreshBaseMs,
    DEFAULT_SOURCE_REFRESH_BASE_MS,
  );
  const log = options.log || (() => {});
  const attempts = buildAttempts(channel, sourcesPerCandidate);

  if (!attempts.length) {
    res.status(502).json({ error: "no playback sources", channel: channel?.name || channel?.id });
    return;
  }

  let clientClosed = false;
  res.once("close", () => {
    clientClosed = true;
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-store");

  const exhaustedCandidates = new Set();

  for (const [index, attempt] of attempts.entries()) {
    if (clientClosed || res.destroyed) return;
    if (exhaustedCandidates.has(attempt.candidateIndex)) continue;

    let result = null;
    for (let recovery = 0; recovery <= sourceRefreshRetries; recovery += 1) {
      if (clientClosed || res.destroyed) return;
      const activeAttempt = recovery === 0
        ? attempt
        : { ...attempt, url: refreshAttemptUrl(attempt.url) };

      if (recovery === 0) {
        log(`try ${index + 1}/${attempts.length}: ${attempt.label} candidate ${attempt.candidateIndex + 1} stream ${attempt.source + 1}`);
      } else {
        log(`refresh retry ${recovery}/${sourceRefreshRetries}: ${attempt.label} candidate ${attempt.candidateIndex + 1} stream ${attempt.source + 1}`);
      }

      result = await runAttempt(activeAttempt, req, res, { stallMs, prebufferMs, log });
      if (result.reason === "client-closed") return;

      log(`failed ${attempt.label} candidate ${attempt.candidateIndex + 1} stream ${attempt.source + 1}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);

      if (recovery < sourceRefreshRetries && resultShouldRefreshSource(result)) {
        const delay = sourceRefreshBaseMs * (2 ** recovery);
        log(`re-resolving same source in ${delay}ms before failover`);
        await sleep(delay);
        continue;
      }
      break;
    }

    if (resultMeansNoMoreSources(result)) {
      exhaustedCandidates.add(attempt.candidateIndex);
      log(`candidate ${attempt.candidateIndex + 1} has no additional provider sources; skipping remaining configured source slots`);
    }
  }

  if (clientClosed || res.destroyed) return;
  if (!res.headersSent) {
    res.status(502).json({ error: "all playback sources failed", channel: channel?.name || channel?.id });
  } else {
    res.end();
  }
}
