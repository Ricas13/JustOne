import { spawn } from "node:child_process";

const DEFAULT_STALL_MS = Math.max(4000, Number(process.env.JELLYFIN_STREAM_STALL_MS || 12000));
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

function runAttempt(attempt, req, res, { stallMs, log }) {
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

    const finish = (reason, detail = "") => {
      if (finished) return;
      finished = true;
      if (watchdog) clearInterval(watchdog);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolve({ reason, detail, bytes });
    };

    child.stdout.on("data", (chunk) => {
      if (finished || res.destroyed || req.aborted) return finish("client-closed");
      lastDataAt = Date.now();
      bytes += chunk.length;
      if (!res.write(chunk)) {
        backpressured = true;
        child.stdout.pause();
        res.once("drain", () => {
          backpressured = false;
          lastDataAt = Date.now();
          child.stdout?.resume();
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });

    child.once("error", (error) => finish("spawn-error", String(error.message || error)));
    child.once("close", (code, signal) => {
      finish("ffmpeg-exit", `code=${code ?? "null"} signal=${signal || "none"} ${stderr.trim()}`.trim());
    });

    watchdog = setInterval(() => {
      if (res.destroyed || req.aborted) return finish("client-closed");
      if (!backpressured && Date.now() - lastDataAt >= stallMs) {
        const phase = bytes ? "stalled" : "no-media";
        log(`${phase}: ${attempt.label} stream ${attempt.source + 1}`);
        finish(phase, `no output for ${stallMs}ms`);
      }
    }, Math.min(1000, Math.max(250, Math.floor(stallMs / 4))));
    watchdog.unref?.();
  });
}

export async function streamSequentially(req, res, channel, options = {}) {
  const stallMs = Math.max(4000, Number(options.stallMs || DEFAULT_STALL_MS));
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
    const result = await runAttempt(attempt, req, res, { stallMs, log });

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
