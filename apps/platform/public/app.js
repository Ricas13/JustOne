const app = document.getElementById("app");

async function health() {
  try { return await (await fetch("/health")).json(); }
  catch { return { checks: {} }; }
}

function overview() {
  app.innerHTML = `
    <h1>JustOne</h1>
    <p class="muted">TRaSH STRM libraries. Resolver 302s to a working source. Video never transits this host.</p>
    <div class="panel">
      <p>Resolver</p>
      <code>GET /resolve/movie/:tmdbId?quality=4k → 302</code><br/>
      <code>GET /resolve/episode/:tmdbId/:s/:e?quality=1080p → 302</code><br/>
      <code>GET /resolve/live/:id → 302</code>
    </div>
    <div class="panel">
      <p>Jellyfin folders</p>
      <code>data/library/movies-1080p · movies-4k · tv-1080p · tv-4k</code>
    </div>`;
}

function library() {
  app.innerHTML = `
    <h1>STRM</h1>
    <p class="muted">Bulk-write TRaSH-named pointers from TMDB trending. Each file is a resolver URL.</p>
    <div class="panel">
      <label>Movie pages (20 titles each) <input id="mp" type="number" value="5" min="0" max="50"/></label><br/><br/>
      <label>TV pages <input id="tp" type="number" value="2" min="0" max="20"/></label><br/><br/>
      <label>Max episodes / show <input id="ep" type="number" value="12" min="1" max="40"/></label><br/><br/>
      <button id="go">Generate</button>
      <p class="muted" id="out"></p>
    </div>`;
  document.getElementById("go").onclick = async () => {
    const out = document.getElementById("out");
    out.textContent = "Writing…";
    try {
      const r = await fetch("/library/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          moviePages: Number(document.getElementById("mp").value),
          tvPages: Number(document.getElementById("tp").value),
          maxEpisodes: Number(document.getElementById("ep").value),
        }),
      });
      const j = await r.json();
      out.textContent = r.ok ? `Wrote ${j.movies} movie files, ${j.episodes} episode files` : (j.error || "failed");
    } catch (e) { out.textContent = String(e); }
  };
}

async function live() {
  app.innerHTML = `<h1>Live M3U</h1><p class="muted">IPTVEditor tags. Entries hit /resolve/live/:id.</p>
    <div class="panel"><button id="ref">Refresh channels</button> <span id="c" class="muted"></span></div>
    <p><code>/live/playlist.m3u8</code></p>
    <pre id="m3u">Loading…</pre>`;
  const load = async () => {
    const t = await (await fetch("/live/playlist.m3u8")).text();
    document.getElementById("m3u").textContent = t.slice(0, 8000);
  };
  document.getElementById("ref").onclick = async () => {
    const j = await (await fetch("/live/refresh", { method: "POST" })).json();
    document.getElementById("c").textContent = `${j.count || 0} channels`;
    await load();
  };
  await load();
}

async function healthPage() {
  const h = await health();
  app.innerHTML = `<h1>Health</h1>
    <div class="panel"><pre>${JSON.stringify(h, null, 2)}</pre></div>`;
}

function route() {
  const h = location.hash || "#/";
  if (h.startsWith("#/library")) return library();
  if (h.startsWith("#/live")) return live();
  if (h.startsWith("#/health")) return healthPage();
  overview();
}
window.addEventListener("hashchange", route);
route();
