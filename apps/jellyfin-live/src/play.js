import { spawn } from "node:child_process";

const DEFAULT_STALL_MS = Math.max(0, Number(process.env.JELLYFIN_STREAM_STALL_MS ?? 12000));
const DEFAULT_PREBUFFER_MS = Math.max(0, Number(process.env.JELLYFIN_PREBUFFER_MS ?? 2000));
const MAX_SOURCES_PER_CANDIDATE = 6;
const DEFAULT_SOURCES_PER_CANDIDATE = Math.max(
  1,
  Math.min(
    MAX_SOURCES_PER_CANDIDATE,
    Number(process.env.JELLYFIN_SOURCES_PER_CANDIDATE || MAX_SOURCES_PER_CANDIDATE),
  ),
);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function sourceUrl(rawUrl, source) {
  const url = new URL(String(rawUrl));
  url.searchParams.set("source", String(source));
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

function ffmpegArgs(url) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "warning",
    "-rw_timeout", "10000000",
    "-i", url,
    "-map", "0:v?",
    "-map", "0:a?",
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

    log(`try ${index + 1}/${attempts.length}: ${attempt.label} candidate ${attempt.candidateIndex + 1} stream ${attempt.source + 1}`);
    const result = await runAttempt(attempt, req, res, { stallMs, prebufferMs, log });

    if (result.reason === "client-closed") return;
    log(`failed ${attempt.label} candidate ${attempt.candidateIndex + 1} stream ${attempt.source + 1}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);

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
