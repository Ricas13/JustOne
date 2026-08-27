const app = document.getElementById("app");
const M3U = `${location.origin}/live/playlist.m3u8`;

async function j(path, opts) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) {
    location.href = "/login";
    return {};
  }
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

function copy(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function overview(st) {
  const p = st?.paths || {};
  app.innerHTML = `
    <h1>JustOne</h1>
    <p class="muted">Admin only. Jellyfin / VLC use the public play URLs — origin stays hidden.</p>
    <div class="panel">
      <p>IPTV playlist (VLC, IPTVEditor, Jellyfin Live TV)</p>
      <code id="m3u">${M3U}</code>
      <p><button type="button" id="copy">Copy M3U URL</button></p>
    </div>
    <div class="panel">
      <p>Libraries</p>
      <code>${p.movies1080 || ""}</code><br/>
      <code>${p.movies4k || ""}</code><br/>
      <code>${p.tv1080 || ""}</code><br/>
      <code>${p.tv4k || ""}</code><br/>
      <code>${p.live || ""}/playlist.m3u8</code>
    </div>
    <div class="panel" id="job">Job: ${st?.phase || "…"} · movies ${st?.movies || 0} · episodes ${st?.episodes || 0} · live ${st?.channels || 0}</div>
    <form method="post" action="/logout"><button type="submit">Log out</button></form>`;
  document.getElementById("copy").onclick = () => copy(M3U);
}

function library(st) {
  app.innerHTML = `
    <h1>STRM</h1>
    <p class="muted">TMDB catalog. Playback goes through /play so clients never see the source host.</p>
    <div class="panel">
      <p id="job">phase ${st?.phase} running=${st?.running} movies=${st?.movies} episodes=${st?.episodes}</p>
      <button id="go" type="button">Generate now</button>
    </div>`;
  document.getElementById("go").onclick = async () => {
    await j("/library/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    poll();
  };
}

async function live() {
  app.innerHTML = `
    <h1>Live IPTV</h1>
    <p class="muted">Paste this URL in VLC (Media → Open Network) or IPTVEditor / Jellyfin as an M3U tuner.</p>
    <div class="panel">
      <code>${M3U}</code>
      <p><button type="button" id="copy">Copy M3U URL</button>
         <button type="button" id="ref">Refresh channels</button>
         <span id="c" class="muted"></span></p>
    </div>
    <pre id="preview">Loading…</pre>`;
  document.getElementById("copy").onclick = () => copy(M3U);
  document.getElementById("ref").onclick = async () => {
    const x = await j("/live/refresh", { method: "POST" });
    document.getElementById("c").textContent = `${x.count || 0} channels`;
    loadPreview();
  };
  loadPreview();
}

async function loadPreview() {
  const r = await fetch("/live/playlist.m3u8", { credentials: "same-origin" });
  const t = await r.text();
  const el = document.getElementById("preview");
  if (el) el.textContent = t.slice(0, 8000);
}

async function poll() {
  const st = await j("/library/status");
  const h = location.hash || "#/";
  if (h.startsWith("#/library")) library(st);
  else if (h.startsWith("#/live")) await live();
  else overview(st);
}

window.addEventListener("hashchange", poll);
poll();
setInterval(() => {
  if (!(location.hash || "#/").startsWith("#/live")) poll();
}, 8000);
