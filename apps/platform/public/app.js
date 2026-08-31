const app = document.getElementById("app");

async function j(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("Authentication required");
  }
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(data?.error || data?.raw || `Request failed (${r.status})`);
  return data;
}

async function maybe(path) {
  try {
    return await j(path);
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function fmtNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function copy(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function badge(text, state = "neutral") {
  return `<span class="badge ${state}">${esc(text)}</span>`;
}

function serviceState(ok, label) {
  return badge(label || (ok ? "Online" : "Offline"), ok ? "ok" : "bad");
}

function urlBox(id, label, url, note = "") {
  return `
    <div class="urlbox">
      <div class="urlhead"><strong>${esc(label)}</strong>${note ? `<span class="muted tiny">${esc(note)}</span>` : ""}</div>
      <div class="urlrow">
        <input id="${esc(id)}" class="url" type="text" readonly value="${esc(url)}" />
        <button type="button" class="secondary" data-copy-from="${esc(id)}">Copy</button>
      </div>
    </div>`;
}

function bindCopies() {
  app.querySelectorAll("[data-copy-from]").forEach((btn) => {
    btn.onclick = () => {
      const el = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!el) return;
      el.select();
      copy(el.value);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 900);
    };
  });
}

function keyedUrl(path, liveLinks) {
  const out = new URL(path, location.origin);
  try {
    const raw = new URL(liveLinks?.all || location.origin);
    for (const [key, value] of raw.searchParams) out.searchParams.set(key, value);
  } catch {
    /* no playlist key */
  }
  return out.href;
}

function activeNav() {
  const h = location.hash || "#/";
  document.querySelectorAll("aside a[data-route]").forEach((a) => {
    const route = a.getAttribute("href");
    a.classList.toggle("active", route === h || (route !== "#/" && h.startsWith(route)));
  });
}

async function core() {
  const [liveStatus, liveLinks, health, jellyfin] = await Promise.all([
    j("/live/status"),
    j("/live/links"),
    j("/health"),
    maybe("/jellyfin/health"),
  ]);
  return { liveStatus, liveLinks, health, jellyfin };
}

async function overview() {
  const { liveStatus, liveLinks, health, jellyfin } = await core();
  const jfOk = Boolean(jellyfin?.ok);
  const cache = health?.cache?.size || 0;
  const locked = Boolean(liveLinks?.locked);
  const jfPlaylist = keyedUrl("/jellyfin/playlist.m3u8", liveLinks);
  const jfGuide = keyedUrl("/jellyfin/guide.xml", liveLinks);
  const stremio = keyedUrl("/stremio/manifest.json", liveLinks);
  const primaryOk = Boolean(health?.checks?.dlhdProxy?.ok);
  const fallbackOk = Boolean(health?.checks?.dlhd?.ok);

  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">LIVE TV CONTROL PLANE</p>
        <h1>JustOne</h1>
        <p class="muted">Live channels, source failover, Jellyfin lineup normalization and guide data in one place.</p>
      </div>
      <div class="actions">
        <button id="refresh-live" type="button">Refresh Live TV</button>
      </div>
    </div>

    <section class="metric-grid">
      <div class="metric">
        <span class="metric-label">Platform channels</span>
        <strong>${fmtNumber(liveStatus?.channels)}</strong>
        ${badge(liveStatus?.error ? "Refresh error" : "Ready", liveStatus?.error ? "bad" : "ok")}
      </div>
      <div class="metric">
        <span class="metric-label">Jellyfin Live</span>
        <strong>${fmtNumber(jellyfin?.channels)} channels</strong>
        ${serviceState(jfOk, jfOk ? "Healthy" : "Unavailable")}
      </div>
      <div class="metric">
        <span class="metric-label">Live resolver cache</span>
        <strong>${fmtNumber(cache)}</strong>
        <span class="muted tiny">validated channel selections</span>
      </div>
      <div class="metric">
        <span class="metric-label">Playlist access</span>
        <strong>${locked ? "Protected" : "Open"}</strong>
        ${badge(locked ? "PLAYLIST_KEY" : "No key", locked ? "ok" : "warn")}
      </div>
      <div class="metric">
        <span class="metric-label">Primary live backend</span>
        <strong>${primaryOk ? "Online" : "Unavailable"}</strong>
        ${serviceState(primaryOk)}
      </div>
      <div class="metric">
        <span class="metric-label">Fallback live backend</span>
        <strong>${fallbackOk ? "Online" : "Unavailable"}</strong>
        ${serviceState(fallbackOk)}
      </div>
    </section>

    ${liveStatus?.error ? `<div class="notice bad"><strong>Live refresh error</strong><br>${esc(liveStatus.error)}</div>` : ""}

    <section class="panel">
      <div class="section-title">
        <div><p class="eyebrow">RECOMMENDED</p><h2>Client endpoints</h2></div>
      </div>
      ${urlBox("jf-m3u", "Jellyfin tuner", jfPlaylist, "Normalized M3U")}
      ${urlBox("jf-xml", "Jellyfin guide", jfGuide, "XMLTV")}
      ${urlBox("stremio-url", "Stremio Live TV manifest", stremio, "Optional")}
    </section>

    <section class="two-col">
      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">SERVICES</p><h2>Status</h2></div><a href="#/health">Details</a></div>
        <div class="rows">
          <div><span>Platform</span>${serviceState(true)}</div>
          <div><span>Primary DLHD proxy</span>${serviceState(primaryOk)}</div>
          <div><span>Fallback DLHD</span>${serviceState(fallbackOk)}</div>
          <div><span>Jellyfin organizer</span>${serviceState(jfOk)}</div>
        </div>
      </div>
      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">LIVE REFRESH</p><h2>Current state</h2></div><a href="#/live">Manage</a></div>
        <div class="rows">
          <div><span>Phase</span><strong>${esc(liveStatus?.phase || "idle")}</strong></div>
          <div><span>Last refresh</span><span>${esc(fmtTime(liveStatus?.lastRefreshAt))}</span></div>
          <div><span>Refresh interval</span><span>${fmtNumber(liveStatus?.refreshMin)} min</span></div>
          <div><span>Runtime path</span><code>${esc(liveStatus?.path || "")}</code></div>
        </div>
      </div>
    </section>`;

  bindCopies();

  document.getElementById("refresh-live").onclick = async () => {
    const btn = document.getElementById("refresh-live");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await j("/live/refresh", { method: "POST" });
      await overview();
    } catch (error) {
      btn.disabled = false;
      btn.textContent = "Refresh Live TV";
      alert(error.message);
    }
  };
}

async function live() {
  const [links, sources, jellyfin] = await Promise.all([
    j("/live/links"),
    j("/live/sources"),
    maybe("/jellyfin/health"),
  ]);
  const jfPlaylist = keyedUrl("/jellyfin/playlist.m3u8", links);
  const jfGuide = keyedUrl("/jellyfin/guide.xml", links);
  const rows = (Array.isArray(sources) ? sources : []).map((source) => `
    <tr>
      <td><strong>${esc(source.name)}</strong><br><span class="muted tiny">${esc(source.id)}</span></td>
      <td class="urlcell">${esc(source.url)}</td>
      <td>${badge(source.enabled === false ? "Disabled" : "Enabled", source.enabled === false ? "neutral" : "ok")}</td>
      <td><button type="button" class="danger ghost small" data-del="${esc(source.id)}">Remove</button></td>
    </tr>`).join("");

  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">LIVE TV</p>
        <h1>Channels & guide</h1>
        <p class="muted">The Jellyfin feed is normalized separately from the raw compatibility feeds.</p>
      </div>
      <div class="actions">
        ${serviceState(Boolean(jellyfin?.ok), jellyfin?.ok ? "Organizer healthy" : "Organizer unavailable")}
        <button id="live-refresh" type="button">Refresh sources</button>
      </div>
    </div>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">JELLYFIN</p><h2>Recommended setup</h2></div></div>
      ${urlBox("jf-live", "M3U tuner", jfPlaylist, `${fmtNumber(jellyfin?.channels || 0)} channels`)}
      ${urlBox("jf-guide", "XMLTV guide", jfGuide, `${fmtNumber(jellyfin?.epgSources || 0)} guide sources`)}
      <div class="feature-grid">
        <div><strong>Adult filtering</strong><span>18+ content excluded from the Jellyfin feed.</span></div>
        <div><strong>Non-live filtering</strong><span>Movie, TV Show, Series and other on-demand groups excluded from the live lineup.</span></div>
        <div><strong>Sports slots</strong><span>Duplicate event sources collapse into reusable sport channels with failover.</span></div>
        <div><strong>EPG & artwork</strong><span>XMLTV mapping and channel artwork enrichment.</span></div>
        <div><strong>Metadata only</strong><span>IPTV-org is used for metadata/guide enrichment, not as a stream source.</span></div>
        <div><strong>Protected URLs</strong><span>${links?.locked ? "Playlist key is enabled." : "Playlist key is not configured."}</span></div>
      </div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">RAW / COMPATIBILITY</p><h2>Platform feeds</h2></div></div>
      ${urlBox("raw-tv", "24/7", links.tv || "", "Raw feed")}
      ${urlBox("raw-sports", "Sports", links.sports || "", "Raw feed")}
      ${urlBox("raw-extra", "Extra sources", links.extra || "", "Raw feed")}
      ${urlBox("raw-all", "Everything", links.all || "", "Raw feed")}
    </section>

    <section class="panel">
      <div class="section-title">
        <div><p class="eyebrow">SOURCES</p><h2>Extra M3U sources</h2></div>
        <span class="muted">${fmtNumber(sources?.length || 0)} configured</span>
      </div>
      <form id="add-source" class="inline-form">
        <input name="name" placeholder="Source name" required>
        <input name="url" type="url" placeholder="https://…/playlist.m3u8" required>
        <button type="submit">Add source</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Source</th><th>URL</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="muted">No extra sources configured.</td></tr>`}</tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <details>
        <summary>Raw playlist preview</summary>
        <pre id="preview" class="preview">Loading…</pre>
      </details>
    </section>`;

  bindCopies();

  document.getElementById("live-refresh").onclick = async () => {
    const btn = document.getElementById("live-refresh");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await j("/live/refresh", { method: "POST" });
      await live();
    } catch (error) {
      btn.disabled = false;
      btn.textContent = "Refresh sources";
      alert(error.message);
    }
  };

  document.getElementById("add-source").onsubmit = async (event) => {
    event.preventDefault();
    const fd = new FormData(event.target);
    await j("/live/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: fd.get("name"), url: fd.get("url") }),
    });
    await live();
  };

  app.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Remove this source?")) return;
      await j("/live/sources/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: btn.getAttribute("data-del") }),
      });
      await live();
    };
  });

  loadPreview(links.all);
}

async function loadPreview(url = "/live/playlist.m3u8") {
  const el = document.getElementById("preview");
  if (!el) return;
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    const text = await response.text();
    el.textContent = text.slice(0, 12000);
  } catch (error) {
    el.textContent = error.message;
  }
}

async function health() {
  const links = await j("/live/links");
  const [h, jf, manifest] = await Promise.all([
    j("/health"),
    maybe("/jellyfin/health"),
    maybe(keyedUrl("/stremio/manifest.json", links)),
  ]);
  const checks = h?.checks || {};
  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">HEALTH</p>
        <h1>Live TV services</h1>
        <p class="muted">Current reachability and in-memory state from the running live stack.</p>
      </div>
      <button id="health-refresh" class="secondary" type="button">Refresh</button>
    </div>

    <section class="metric-grid">
      <div class="metric"><span class="metric-label">Platform</span><strong>Online</strong>${badge("HTTP active", "ok")}</div>
      <div class="metric"><span class="metric-label">Primary DLHD proxy</span><strong>${checks?.dlhdProxy?.status || "—"}</strong>${serviceState(Boolean(checks?.dlhdProxy?.ok))}</div>
      <div class="metric"><span class="metric-label">Fallback DLHD</span><strong>${checks?.dlhd?.status || "—"}</strong>${serviceState(Boolean(checks?.dlhd?.ok))}</div>
      <div class="metric"><span class="metric-label">Jellyfin organizer</span><strong>${jf?.ok ? "Online" : "Offline"}</strong>${serviceState(Boolean(jf?.ok))}</div>
      <div class="metric"><span class="metric-label">Stremio Live TV</span><strong>${esc(manifest?.name || "Unavailable")}</strong>${serviceState(Boolean(manifest?.id))}</div>
      <div class="metric"><span class="metric-label">Resolver cache</span><strong>${fmtNumber(h?.cache?.size)}</strong><span class="muted tiny">live entries</span></div>
    </section>

    <section class="two-col">
      <div class="panel">
        <div class="section-title"><div><h2>Jellyfin organizer</h2></div></div>
        <div class="rows">
          <div><span>Last refresh</span><span>${esc(fmtTime(jf?.lastRefresh))}</span></div>
          <div><span>Raw channels</span><strong>${fmtNumber(jf?.rawChannels)}</strong></div>
          <div><span>Output channels</span><strong>${fmtNumber(jf?.channels)}</strong></div>
          <div><span>EPG sources</span><strong>${fmtNumber(jf?.epgSources)}</strong></div>
          <div><span>Error</span><span>${esc(jf?.error || "None")}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="section-title"><div><h2>Live resolver</h2></div></div>
        <div class="rows">
          <div><span>Phase</span><strong>${esc(h?.live?.phase || "idle")}</strong></div>
          <div><span>Refreshing</span><span>${h?.live?.running ? "Yes" : "No"}</span></div>
          <div><span>Channels</span><strong>${fmtNumber(h?.live?.channels)}</strong></div>
          <div><span>Last refresh</span><span>${esc(fmtTime(h?.live?.lastRefreshAt))}</span></div>
          <div><span>Error</span><span>${esc(h?.live?.error || "None")}</span></div>
        </div>
      </div>
    </section>

    <section class="panel">
      <details>
        <summary>Raw health response</summary>
        <pre>${esc(JSON.stringify({ platform: h, jellyfin: jf, stremio: manifest ? { id: manifest.id, name: manifest.name, version: manifest.version } : null }, null, 2))}</pre>
      </details>
    </section>`;

  document.getElementById("health-refresh").onclick = health;
}

function settingRow(name, value, description) {
  return `<tr><td><code>${esc(name)}</code></td><td>${esc(value)}</td><td class="muted">${esc(description)}</td></tr>`;
}

async function settings() {
  const [status, links] = await Promise.all([j("/live/status"), j("/live/links")]);
  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">CONFIGURATION</p>
        <h1>Settings reference</h1>
        <p class="muted">Runtime configuration comes from <code>.env</code>. Secret values are never displayed here. Recreate the affected container after changing environment settings.</p>
      </div>
    </div>

    <section class="metric-grid">
      <div class="metric"><span class="metric-label">Live refresh</span><strong>${fmtNumber(status?.refreshMin)} min</strong></div>
      <div class="metric"><span class="metric-label">Playlist key</span><strong>${links?.locked ? "Configured" : "Not configured"}</strong>${badge(links?.locked ? "Protected" : "Open", links?.locked ? "ok" : "warn")}</div>
      <div class="metric"><span class="metric-label">Current channels</span><strong>${fmtNumber(status?.channels)}</strong></div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">LIVE TV</p><h2>Guide & refresh options</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead><tbody>
        ${settingRow("LIVE_REFRESH_MIN", "360", "Raw platform Live TV discovery and playlist refresh interval.")}
        ${settingRow("JELLYFIN_REFRESH_MIN", "10", "Normalized Jellyfin lineup refresh interval.")}
        ${settingRow("JELLYFIN_AUTO_EPG", "true", "Automatically discover matching guide sources.")}
        ${settingRow("JELLYFIN_EPG_MAX_SOURCES", "12", "Maximum automatic XMLTV sources.")}
        ${settingRow("JELLYFIN_EPG_CACHE_MIN", "60", "External XMLTV cache lifetime.")}
        ${settingRow("JELLYFIN_EXCLUDE_ADULT", "true", "Exclude adult entries from the Jellyfin feed.")}
        ${settingRow("EPG_URL", "empty", "Optional explicit XMLTV source.")}
        ${settingRow("JELLYFIN_EPG_SOURCE_URLS", "empty", "Optional comma-separated XMLTV sources.")}
      </tbody></table></div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">LIVE RESOLVER</p><h2>Playback & security</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead><tbody>
        ${settingRow("RESOLVE_TTL_MS", "3600000", "Maximum in-memory live source cache lifetime.")}
        ${settingRow("LIVE_SOURCE_PROBE_TIMEOUT_MS", "7000", "Maximum media-aware validation time for a live provider candidate.")}
        ${settingRow("LIVE_SOURCE_RECHECK_MS", "15000", "How soon a cached live source must prove readable media again.")}
        ${settingRow("ADMIN_PASSWORD", "secret", "Protects this admin dashboard. Value is never shown here.")}
        ${settingRow("PLAYLIST_KEY", "secret", "Protects stream, guide and artwork URLs. Value is never shown here.")}
      </tbody></table></div>
    </section>`;

  bindCopies();
}

async function route() {
  activeNav();
  const h = location.hash || "#/";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    if (h.startsWith("#/live")) await live();
    else if (h.startsWith("#/health")) await health();
    else if (h.startsWith("#/settings")) await settings();
    else await overview();
  } catch (error) {
    app.innerHTML = `<div class="notice bad"><strong>Dashboard error</strong><br>${esc(error.message)}</div>`;
  }
  activeNav();
}

window.addEventListener("hashchange", route);
route();

setInterval(() => {
  const h = location.hash || "#/";
  if (h === "#/" || h === "") overview().catch(() => {});
  else if (h.startsWith("#/health")) health().catch(() => {});
}, 8000);
