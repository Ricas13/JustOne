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

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
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
    for (const [k, v] of raw.searchParams) out.searchParams.set(k, v);
  } catch {
    /* no key */
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
  const [library, liveLinks, health, jellyfin] = await Promise.all([
    j("/library/status"),
    j("/live/links"),
    j("/health"),
    maybe("/jellyfin/health"),
  ]);
  return { library, liveLinks, health, jellyfin };
}

function jobSummary(st) {
  const running = Boolean(st?.running);
  const state = st?.error ? "bad" : running ? "warn" : st?.phase === "done" ? "ok" : "neutral";
  const label = st?.error ? "Error" : running ? "Running" : st?.phase || "Idle";
  return { state, label };
}

async function overview() {
  const { library: st, liveLinks, health, jellyfin } = await core();
  const job = jobSummary(st);
  const jfOk = Boolean(jellyfin?.ok);
  const cache = health?.cache?.size || 0;
  const locked = Boolean(liveLinks?.locked);
  const jfPlaylist = keyedUrl("/jellyfin/playlist.m3u8", liveLinks);
  const jfGuide = keyedUrl("/jellyfin/guide.xml", liveLinks);
  const stremio = `${location.origin}/stremio/manifest.json`;

  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">CONTROL PLANE</p>
        <h1>JustOne</h1>
        <p class="muted">Library generation, resolver cache, Live TV, guide data and service health in one place.</p>
      </div>
      <div class="actions">
        <button id="gen-now" type="button">Generate library</button>
        <button id="refresh-live" class="secondary" type="button">Refresh Live TV</button>
      </div>
    </div>

    <section class="metric-grid">
      <div class="metric">
        <span class="metric-label">Library job</span>
        <strong>${esc(job.label)}</strong>
        ${badge(st?.running ? "Active" : "Idle", job.state)}
      </div>
      <div class="metric">
        <span class="metric-label">Generated</span>
        <strong>${fmtNumber((st?.movies || 0) + (st?.episodes || 0))}</strong>
        <span class="muted tiny">${fmtNumber(st?.movies)} movie files · ${fmtNumber(st?.episodes)} episode files</span>
      </div>
      <div class="metric">
        <span class="metric-label">Jellyfin Live</span>
        <strong>${fmtNumber(jellyfin?.channels || 0)} channels</strong>
        ${serviceState(jfOk, jfOk ? "Healthy" : "Unavailable")}
      </div>
      <div class="metric">
        <span class="metric-label">Resolver cache</span>
        <strong>${fmtNumber(cache)}</strong>
        <span class="muted tiny">resolved entries in memory</span>
      </div>
      <div class="metric">
        <span class="metric-label">Playlist access</span>
        <strong>${locked ? "Protected" : "Open"}</strong>
        ${badge(locked ? "PLAYLIST_KEY" : "No key", locked ? "ok" : "warn")}
      </div>
      <div class="metric">
        <span class="metric-label">Live source cache</span>
        <strong>${fmtNumber(st?.channels || 0)}</strong>
        <span class="muted tiny">last platform channel count</span>
      </div>
    </section>

    ${st?.error ? `<div class="notice bad"><strong>Generation error</strong><br>${esc(st.error)}</div>` : ""}

    <section class="panel">
      <div class="section-title">
        <div><p class="eyebrow">RECOMMENDED</p><h2>Client endpoints</h2></div>
      </div>
      ${urlBox("jf-m3u", "Jellyfin tuner", jfPlaylist, "Clean M3U")}
      ${urlBox("jf-xml", "Jellyfin guide", jfGuide, "XMLTV")}
      ${urlBox("stremio-url", "Stremio manifest", stremio, "Addon")}
    </section>

    <section class="two-col">
      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">SERVICES</p><h2>Status</h2></div><a href="#/health">Details</a></div>
        <div class="rows">
          <div><span>Platform</span>${serviceState(true)}</div>
          <div><span>Resolver backend</span>${serviceState(Boolean(health?.checks?.cinepro?.ok))}</div>
          <div><span>Live backend</span>${serviceState(Boolean(health?.checks?.dlhd?.ok))}</div>
          <div><span>Jellyfin organizer</span>${serviceState(jfOk)}</div>
        </div>
      </div>
      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">LATEST JOB</p><h2>Library</h2></div><a href="#/library">Manage</a></div>
        <div class="rows">
          <div><span>Phase</span><strong>${esc(st?.phase || "idle")}</strong></div>
          <div><span>Started</span><span>${esc(fmtTime(st?.startedAt))}</span></div>
          <div><span>Finished</span><span>${esc(fmtTime(st?.finishedAt))}</span></div>
          <div><span>Detail</span><span>${esc(st?.detail || "—")}</span></div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">STORAGE</p><h2>Library paths</h2></div></div>
      <div class="path-grid">
        <div><span>Movies 1080p</span><code>${esc(st?.paths?.movies1080 || "")}</code></div>
        <div><span>Movies 4K</span><code>${esc(st?.paths?.movies4k || "")}</code></div>
        <div><span>TV 1080p</span><code>${esc(st?.paths?.tv1080 || "")}</code></div>
        <div><span>TV 4K</span><code>${esc(st?.paths?.tv4k || "")}</code></div>
        <div><span>Live</span><code>${esc(st?.paths?.live || "")}</code></div>
      </div>
    </section>`;

  bindCopies();

  document.getElementById("gen-now").onclick = async () => {
    const btn = document.getElementById("gen-now");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      await j("/library/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await overview();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Generate library";
      alert(e.message);
    }
  };

  document.getElementById("refresh-live").onclick = async () => {
    const btn = document.getElementById("refresh-live");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await j("/live/refresh", { method: "POST" });
      await overview();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Refresh Live TV";
      alert(e.message);
    }
  };
}

function libraryStatusMarkup(st) {
  const job = jobSummary(st);
  const elapsed = st?.startedAt
    ? fmtDuration((st?.finishedAt || Date.now()) - st.startedAt)
    : "—";
  return `
    <div class="status-strip">
      <div><span>Status</span>${badge(job.label, job.state)}</div>
      <div><span>Movies</span><strong>${fmtNumber(st?.movies)}</strong></div>
      <div><span>Episodes</span><strong>${fmtNumber(st?.episodes)}</strong></div>
      <div><span>Elapsed</span><strong>${esc(elapsed)}</strong></div>
    </div>
    ${st?.detail ? `<p class="muted" style="margin-top:12px">Current: ${esc(st.detail)}</p>` : ""}
    ${st?.error ? `<div class="notice bad">${esc(st.error)}</div>` : ""}`;
}

async function library() {
  const st = await j("/library/status");
  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">LIBRARY</p>
        <h1>STRM generation</h1>
        <p class="muted">TRaSH/Jellyfin-compatible names, dynamic playback URLs and low-impact write pacing.</p>
      </div>
    </div>

    <section class="panel">
      <div class="section-title"><div><h2>Current job</h2></div></div>
      <div id="library-status">${libraryStatusMarkup(st)}</div>
    </section>

    <section class="panel">
      <div class="section-title">
        <div><p class="eyebrow">FULL REFRESH</p><h2>Generate library</h2></div>
      </div>
      <p class="muted">Leave fields blank to use the values configured in <code>.env</code>. A running job cannot be started twice.</p>
      <form id="generate-form" class="form-grid">
        <label><span>Movie pages</span><input name="moviePages" type="number" min="1" max="50" placeholder="Configured default"></label>
        <label><span>TV pages</span><input name="tvPages" type="number" min="1" max="40" placeholder="Configured default"></label>
        <label><span>Episodes / season</span><input name="maxEpisodes" type="number" min="1" max="40" placeholder="Configured default"></label>
        <div class="form-action"><button type="submit" ${st?.running ? "disabled" : ""}>${st?.running ? "Already running" : "Generate now"}</button></div>
      </form>
      <p id="generate-msg" class="muted"></p>
    </section>

    <section class="two-col">
      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">SINGLE ITEM</p><h2>Add movie</h2></div></div>
        <form id="movie-form" class="stack">
          <label><span>Title</span><input name="title" required placeholder="Movie title"></label>
          <div class="form-grid compact">
            <label><span>Year</span><input name="year" type="number" min="1900" max="2100"></label>
            <label><span>TMDb ID</span><input name="tmdbId" type="number" min="1" required></label>
          </div>
          <button type="submit">Write STRM</button>
          <p class="muted tiny">Uses the qualities configured for the platform.</p>
        </form>
      </div>

      <div class="panel">
        <div class="section-title"><div><p class="eyebrow">SINGLE ITEM</p><h2>Add episode</h2></div></div>
        <form id="episode-form" class="stack">
          <label><span>Series title</span><input name="showTitle" required placeholder="Series title"></label>
          <div class="form-grid compact">
            <label><span>Year</span><input name="year" type="number" min="1900" max="2100"></label>
            <label><span>TMDb ID</span><input name="tmdbId" type="number" min="1" required></label>
            <label><span>TVDb ID</span><input name="tvdbId" type="number" min="1"></label>
            <label><span>Season</span><input name="season" type="number" min="1" required></label>
            <label><span>Episode</span><input name="episode" type="number" min="1" required></label>
            <label><span>Episode title</span><input name="episodeTitle" placeholder="Optional"></label>
          </div>
          <button type="submit">Write STRM</button>
          <p class="muted tiny">If no episode title is supplied, the writer can use available metadata during normal generation.</p>
        </form>
      </div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">NAMING</p><h2>Generated layout</h2></div></div>
      <pre class="example">Movies/
└── Movie Title (2026) [tmdbid-12345]/
    └── Movie Title (2026).strm

TV/
└── Series Title (2026) [tvdbid-12345]/
    └── Season 01/
        └── Series Title (2026) - S01E01 - Episode Title.strm</pre>
      <div class="path-grid" style="margin-top:16px">
        <div><span>Generate on start</span><strong>${st?.generateOnStart ? "Yes" : "No"}</strong></div>
        <div><span>Quality fallback</span><strong>${st?.qualityFallback ? "Enabled" : "Disabled"}</strong></div>
      </div>
    </section>`;

  document.getElementById("generate-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {};
    for (const key of ["moviePages", "tvPages", "maxEpisodes"]) {
      const raw = String(fd.get(key) || "").trim();
      if (raw) body[key] = Number(raw);
    }
    const msg = document.getElementById("generate-msg");
    msg.textContent = "Starting…";
    try {
      await j("/library/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      msg.textContent = "Generation started.";
      const latest = await j("/library/status");
      document.getElementById("library-status").innerHTML = libraryStatusMarkup(latest);
      e.target.querySelector("button").disabled = true;
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  document.getElementById("movie-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      title: fd.get("title"),
      year: Number(fd.get("year") || 0),
      tmdbId: Number(fd.get("tmdbId")),
    };
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Writing…";
    try {
      await j("/library/movie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      btn.textContent = "Written";
      setTimeout(() => { btn.disabled = false; btn.textContent = "Write STRM"; }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Write STRM";
      alert(err.message);
    }
  };

  document.getElementById("episode-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      showTitle: fd.get("showTitle"),
      year: Number(fd.get("year") || 0),
      tmdbId: Number(fd.get("tmdbId")),
      tvdbId: Number(fd.get("tvdbId") || 0) || undefined,
      season: Number(fd.get("season")),
      episode: Number(fd.get("episode")),
      episodeTitle: String(fd.get("episodeTitle") || "").trim() || undefined,
    };
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Writing…";
    try {
      await j("/library/episode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      btn.textContent = "Written";
      setTimeout(() => { btn.disabled = false; btn.textContent = "Write STRM"; }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Write STRM";
      alert(err.message);
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
  const rows = (Array.isArray(sources) ? sources : []).map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong><br><span class="muted tiny">${esc(s.id)}</span></td>
      <td class="urlcell">${esc(s.url)}</td>
      <td>${badge(s.enabled === false ? "Disabled" : "Enabled", s.enabled === false ? "neutral" : "ok")}</td>
      <td><button type="button" class="danger ghost small" data-del="${esc(s.id)}">Remove</button></td>
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
        <div><strong>VOD filtering</strong><span>Movie, TV Show, Series and VOD groups excluded.</span></div>
        <div><strong>Sports slots</strong><span>Duplicate event sources collapse into reusable sport channels with failover.</span></div>
        <div><strong>EPG & artwork</strong><span>XMLTV mapping, fallback programme data and non-blank artwork.</span></div>
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
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Refresh sources";
      alert(e.message);
    }
  };

  document.getElementById("add-source").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
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
    const r = await fetch(url, { credentials: "same-origin" });
    const t = await r.text();
    el.textContent = t.slice(0, 12000);
  } catch (e) {
    el.textContent = e.message;
  }
}

async function health() {
  const [h, jf, manifest] = await Promise.all([
    j("/health"),
    maybe("/jellyfin/health"),
    maybe("/stremio/manifest.json"),
  ]);
  const checks = h?.checks || {};
  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">HEALTH</p>
        <h1>Services</h1>
        <p class="muted">Current reachability and in-memory state from the running stack.</p>
      </div>
      <button id="health-refresh" class="secondary" type="button">Refresh</button>
    </div>

    <section class="metric-grid">
      <div class="metric"><span class="metric-label">Platform</span><strong>Online</strong>${badge("HTTP active", "ok")}</div>
      <div class="metric"><span class="metric-label">Resolver backend</span><strong>${checks?.cinepro?.status || "—"}</strong>${serviceState(Boolean(checks?.cinepro?.ok))}</div>
      <div class="metric"><span class="metric-label">Live backend</span><strong>${checks?.dlhd?.status || "—"}</strong>${serviceState(Boolean(checks?.dlhd?.ok))}</div>
      <div class="metric"><span class="metric-label">Jellyfin organizer</span><strong>${jf?.ok ? "Online" : "Offline"}</strong>${serviceState(Boolean(jf?.ok))}</div>
      <div class="metric"><span class="metric-label">Stremio addon</span><strong>${esc(manifest?.name || "Unavailable")}</strong>${serviceState(Boolean(manifest?.id))}</div>
      <div class="metric"><span class="metric-label">Resolver cache</span><strong>${fmtNumber(h?.cache?.size)}</strong><span class="muted tiny">entries</span></div>
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
        <div class="section-title"><div><h2>Library worker</h2></div></div>
        <div class="rows">
          <div><span>Phase</span><strong>${esc(h?.library?.phase || "idle")}</strong></div>
          <div><span>Running</span><span>${h?.library?.running ? "Yes" : "No"}</span></div>
          <div><span>Movies</span><strong>${fmtNumber(h?.library?.movies)}</strong></div>
          <div><span>Episodes</span><strong>${fmtNumber(h?.library?.episodes)}</strong></div>
          <div><span>Error</span><span>${esc(h?.library?.error || "None")}</span></div>
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
  const [st, links] = await Promise.all([j("/library/status"), j("/live/links")]);
  app.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">CONFIGURATION</p>
        <h1>Settings reference</h1>
        <p class="muted">Runtime configuration comes from <code>.env</code>. This page intentionally never displays secret values. Recreate the affected container after changing environment settings.</p>
      </div>
    </div>

    <section class="metric-grid">
      <div class="metric"><span class="metric-label">Generate on start</span><strong>${st?.generateOnStart ? "Enabled" : "Disabled"}</strong></div>
      <div class="metric"><span class="metric-label">Quality fallback</span><strong>${st?.qualityFallback ? "Enabled" : "Disabled"}</strong></div>
      <div class="metric"><span class="metric-label">Playlist key</span><strong>${links?.locked ? "Configured" : "Not configured"}</strong>${badge(links?.locked ? "Protected" : "Open", links?.locked ? "ok" : "warn")}</div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">LIBRARY</p><h2>Generation options</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead><tbody>
        ${settingRow("GENERATE_ON_START", "true", "Generate the initial STRM library when no first-run marker exists.")}
        ${settingRow("CATALOG_REFRESH_HOURS", "6", "Scheduled library/catalog refresh interval.")}
        ${settingRow("MOVIE_PAGES", "40", "Movie catalogue pages scanned per source list.")}
        ${settingRow("TV_PAGES", "25", "TV catalogue pages scanned per source list.")}
        ${settingRow("TV_MAX_EPISODES", "24", "Maximum episodes generated per season.")}
        ${settingRow("TV_MAX_SEASONS", "4", "Maximum seasons generated per show.")}
        ${settingRow("MAX_MOVIES", "5000", "Upper movie catalogue limit.")}
        ${settingRow("MAX_SHOWS", "1500", "Upper TV-show catalogue limit.")}
        ${settingRow("QUALITIES", "1080p,4k", "STRM quality libraries to generate.")}
        ${settingRow("STRM_IO_DELAY_MS", "20", "Delay between STRM I/O operations; raise it for lower background load.")}
        ${settingRow("QUALITY_FALLBACK", "true", "Allow a lower available source when the requested quality is unavailable.")}
        ${settingRow("DISCOVER_FROM_YEAR", "1980", "Oldest year considered by discovery backfill.")}
      </tbody></table></div>
    </section>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">LIVE TV</p><h2>Guide & refresh options</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead><tbody>
        ${settingRow("LIVE_REFRESH_MIN", "360", "Raw platform Live TV cache refresh interval.")}
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
      <div class="section-title"><div><p class="eyebrow">RESOLVER & SECURITY</p><h2>Other options</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead><tbody>
        ${settingRow("RESOLVE_TTL_MS", "900000", "In-memory resolved-stream cache lifetime.")}
        ${settingRow("ADMIN_PASSWORD", "secret", "Protects this admin dashboard. Value is never shown here.")}
        ${settingRow("PLAYLIST_KEY", "secret", "Protects stream, guide and artwork URLs. Value is never shown here.")}
        ${settingRow("TMDB_API_KEY", "secret", "Metadata/catalogue API credential. Value is never shown here.")}
      </tbody></table></div>
    </section>`;

  bindCopies();
}

async function refreshLibraryStatusOnly() {
  const el = document.getElementById("library-status");
  if (!el) return;
  try {
    const st = await j("/library/status");
    el.innerHTML = libraryStatusMarkup(st);
  } catch {
    /* next tick */
  }
}

async function route() {
  activeNav();
  const h = location.hash || "#/";
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    if (h.startsWith("#/library")) await library();
    else if (h.startsWith("#/live")) await live();
    else if (h.startsWith("#/health")) await health();
    else if (h.startsWith("#/settings")) await settings();
    else await overview();
  } catch (e) {
    app.innerHTML = `<div class="notice bad"><strong>Dashboard error</strong><br>${esc(e.message)}</div>`;
  }
  activeNav();
}

window.addEventListener("hashchange", route);
route();

setInterval(() => {
  const h = location.hash || "#/";
  if (h === "#/" || h === "") overview().catch(() => {});
  else if (h.startsWith("#/health")) health().catch(() => {});
  else if (h.startsWith("#/library")) refreshLibraryStatusOnly();
}, 8000);
