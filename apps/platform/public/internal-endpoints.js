let discoveredPlaybackOrigin = "";
let discovering = null;

function visibleTunerInput() {
  return document.getElementById("jf-m3u") || document.getElementById("jf-live");
}

function firstPlaybackOrigin(body) {
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const url = new URL(line);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      /* ignore malformed playlist rows */
    }
  }
  return "";
}

async function discoverPlaybackOrigin() {
  if (discoveredPlaybackOrigin) return discoveredPlaybackOrigin;
  if (discovering) return discovering;

  const tuner = visibleTunerInput();
  if (!tuner?.value) return "";

  discovering = fetch(tuner.value, { credentials: "same-origin", cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return "";
      const origin = firstPlaybackOrigin(await response.text());
      if (origin) discoveredPlaybackOrigin = origin;
      return discoveredPlaybackOrigin;
    })
    .catch(() => "")
    .finally(() => {
      discovering = null;
    });
  return discovering;
}

function rewriteInput(id, path, origin) {
  const input = document.getElementById(id);
  if (!input?.value || !origin) return;

  try {
    const current = new URL(input.value);
    const next = new URL(path, `${origin}/`);
    next.search = current.search;
    input.value = next.href;
  } catch {
    /* leave the existing dashboard value untouched */
  }
}

async function refreshInternalEndpoints() {
  const origin = await discoverPlaybackOrigin();
  if (!origin || origin === location.origin) return;

  rewriteInput("jf-m3u", "/jellyfin/playlist.m3u8", origin);
  rewriteInput("jf-xml", "/jellyfin/guide.xml", origin);
  rewriteInput("jf-live", "/jellyfin/playlist.m3u8", origin);
  rewriteInput("jf-guide", "/jellyfin/guide.xml", origin);
}

const observer = new MutationObserver(() => {
  if (visibleTunerInput()) refreshInternalEndpoints();
});
observer.observe(document.getElementById("app"), { childList: true, subtree: true });
refreshInternalEndpoints();
