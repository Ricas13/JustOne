const MANIFEST_PREFIX_MAX_BYTES = 128 * 1024;
const MEDIA_PREFIX_MAX_BYTES = 1024;
const HLS_MAX_DEPTH = 3;

function remainingMs(deadline) {
  return Math.max(0, Number(deadline || 0) - Date.now());
}

function probeHeaders(requestHeaders = {}, userAgent, { range = true } = {}) {
  const headers = {
    "user-agent": userAgent,
    accept: "*/*",
    ...(requestHeaders || {}),
  };

  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === "range" && !range) delete headers[key];
  }

  if (range) {
    const hasRange = Object.keys(headers).some((key) => String(key).toLowerCase() === "range");
    if (!hasRange) headers.Range = "bytes=0-0";
  }
  return headers;
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    /* best-effort connection cleanup */
  }
}

async function readPrefix(response, maxBytes) {
  if (!response?.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best-effort connection cleanup */
    }
  }
  return Buffer.concat(chunks, total);
}

async function fetchProbe(
  url,
  requestHeaders,
  deadline,
  timeoutLimitMs,
  userAgent,
  { range = true } = {},
) {
  const remaining = remainingMs(deadline);
  if (!remaining) return null;
  const timeout = Math.min(Math.max(500, Number(timeoutLimitMs || 5000)), remaining);
  try {
    return await fetch(url, {
      method: "GET",
      headers: probeHeaders(requestHeaders, userAgent, { range }),
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return null;
  }
}

function successful(response) {
  return Boolean(response && response.status >= 200 && response.status < 300);
}

function contentType(response) {
  return String(response?.headers?.get?.("content-type") || "").toLowerCase();
}

function hlsHint(response, url) {
  const ct = contentType(response);
  const value = String(response?.url || url || "").toLowerCase();
  return (
    ct.includes("mpegurl") ||
    ct.includes("vnd.apple.mpegurl") ||
    /\.m3u8(?:$|[?#])/i.test(value)
  );
}

function hlsPrefix(prefix) {
  return prefix.toString("utf8").trimStart().startsWith("#EXTM3U");
}

function obviousErrorPayload(response, prefix) {
  const ct = contentType(response);
  if (
    ct.includes("application/json") ||
    ct.includes("problem+json") ||
    ct.includes("text/html") ||
    ct.includes("application/xml") ||
    ct.includes("text/xml") ||
    ct.includes("javascript")
  ) {
    return true;
  }
  if (ct.startsWith("text/") && !ct.includes("mpegurl")) return true;

  const first = prefix.toString("utf8").trimStart().slice(0, 1);
  return first === "<" || first === "{" || first === "[";
}

function resolveTarget(value, baseUrl) {
  try {
    const resolved = new URL(String(value || "").trim(), baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function attributeUri(line) {
  const match = String(line).match(/\bURI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/i);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function firstHlsTarget(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/);
  let nextLineIsPlaylist = false;
  let fallback = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      if (/^#EXT-X-STREAM-INF/i.test(line)) nextLineIsPlaylist = true;

      if (/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)/i.test(line)) {
        const uri = attributeUri(line);
        const url = uri ? resolveTarget(uri, baseUrl) : null;
        if (url && !fallback) fallback = { url, playlist: true };
      } else if (/^#EXT-X-(?:PART|PRELOAD-HINT|MAP)/i.test(line)) {
        const uri = attributeUri(line);
        const url = uri ? resolveTarget(uri, baseUrl) : null;
        if (url && !fallback) fallback = { url, playlist: false };
      }
      continue;
    }

    const url = resolveTarget(line, baseUrl);
    if (!url) continue;
    return {
      url,
      playlist: nextLineIsPlaylist || /\.m3u8(?:$|[?#])/i.test(url),
    };
  }

  return fallback;
}

async function validateMediaUrl(url, requestHeaders, deadline, timeoutLimitMs, userAgent, depth) {
  if (depth > HLS_MAX_DEPTH) return false;
  const response = await fetchProbe(url, requestHeaders, deadline, timeoutLimitMs, userAgent, {
    range: true,
  });
  if (!successful(response)) {
    await cancelBody(response);
    return false;
  }

  if (hlsHint(response, url)) {
    const finalUrl = response.url || url;
    await cancelBody(response);
    return validateHlsManifest(
      finalUrl,
      requestHeaders,
      deadline,
      timeoutLimitMs,
      userAgent,
      depth + 1,
    );
  }

  const prefix = await readPrefix(response, MEDIA_PREFIX_MAX_BYTES);
  if (!prefix.length) return false;
  if (hlsPrefix(prefix)) {
    return validateHlsManifest(
      response.url || url,
      requestHeaders,
      deadline,
      timeoutLimitMs,
      userAgent,
      depth + 1,
    );
  }
  return !obviousErrorPayload(response, prefix);
}

async function validateHlsManifest(
  url,
  requestHeaders,
  deadline,
  timeoutLimitMs,
  userAgent,
  depth = 0,
) {
  if (depth > HLS_MAX_DEPTH) return false;
  const response = await fetchProbe(url, requestHeaders, deadline, timeoutLimitMs, userAgent, {
    range: false,
  });
  if (!successful(response)) {
    await cancelBody(response);
    return false;
  }

  const body = await readPrefix(response, MANIFEST_PREFIX_MAX_BYTES);
  if (!body.length || !hlsPrefix(body)) return false;
  const baseUrl = response.url || url;
  const target = firstHlsTarget(body.toString("utf8"), baseUrl);
  if (!target?.url) return false;

  if (target.playlist) {
    return validateHlsManifest(
      target.url,
      requestHeaders,
      deadline,
      timeoutLimitMs,
      userAgent,
      depth + 1,
    );
  }
  return validateMediaUrl(
    target.url,
    requestHeaders,
    deadline,
    timeoutLimitMs,
    userAgent,
    depth + 1,
  );
}

/**
 * Prove that a resolver candidate reaches real media, not merely an HTTP 2xx.
 * Direct files must return non-error bytes. HLS candidates must expose a valid
 * manifest and at least one readable media segment. This keeps HTML/JSON error
 * pages and manifest-only dead streams out of the admitted Jellyfin catalog.
 */
export async function validatePlaybackMedia(
  candidate,
  deadline,
  timeoutLimitMs = 5000,
  userAgent = "JustOne source resolver",
) {
  if (!candidate?.probeUrl) return false;
  const probeUrl = candidate.probeUrl;
  const requestHeaders = candidate.requestHeaders || {};

  // Resolver endpoints are known HLS URLs. Go straight to manifest validation
  // instead of issuing a ranged GET first and then fetching the same manifest
  // again after recognising it as HLS.
  if (/\.m3u8(?:$|[?#])/i.test(String(probeUrl))) {
    return validateHlsManifest(
      probeUrl,
      requestHeaders,
      deadline,
      timeoutLimitMs,
      userAgent,
      0,
    );
  }

  return validateMediaUrl(
    probeUrl,
    requestHeaders,
    deadline,
    timeoutLimitMs,
    userAgent,
    0,
  );
}
