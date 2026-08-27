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
    <p class="muted">Live channels + TMDB STRMs refresh every 6 hours. Generate now runs the same job immediately.</p>
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
  const sources = await j("/live/sources");
  const rows = (Array.isArray(sources) ? sources : []).map(
    (s) =>
      `<tr><td>${esc(s.name)}</td><td class="muted">${esc(s.url)}</td><td><button type="button" data-del="${esc(s.id)}">Remove</button></td></tr>`,
  ).join("");
  app.innerHTML = `
    <h1>Live IPTV</h1>
    <p class="muted">One playlist for VLC / IPTVEditor / Jellyfin. DLStreams is scraped automatically. Extra sources are M3U URLs you paste (SVT, PLTV, VAVOO, …) — those vaults are not public pages we can scrape.</p>
    <div class="panel">
      <code>${M3U}</code>
      <p><button type="button" id="copy">Copy M3U URL</button>
         <button type="button" id="ref">Refresh all sources</button>
         <span id="c" class="muted"></span></p>
    </div>
    <div class="panel">
      <h2>Extra M3U sources</h2>
      <p class="muted">Add a playlist URL. Group title becomes the source name. Playback still goes through /play so the origin stays hidden.</p>
      <form id="add">
        <input name="name" list="hints" placeholder="Name (e.g. VAVOO)" required />
        <input name="url" type="url" placeholder="https://…/playlist.m3u8" required />
        <button type="submit">Add source</button>
      </form>
      <datalist id="hints">
        <option value="Strong Vault TV (SVT)"></option>
        <option value="Premium Live TV Vault (PLTV1)"></option>
        <option value="Premium Live TV Vault 2 (PLTV2)"></option>
        <option value="TV247US"></option>
        <option value="SharkStreams"></option>
        <option value="VAVOO"></option>
        <option value="Live Sports"></option>
        <option value="Libre Futbol"></option>
        <option value="Free Live Sports"></option>
        <option value="Pirates IPTV"></option>
        <option value="CNCVerse"></option>
        <option value="Toonami Aftermath"></option>
      </datalist>
      <table>${rows || "<tr><td class=muted>No extra sources yet. Toonami Aftermath is added on first run.</td></tr>"}</table>
    </div>
    <pre id="preview">Loading…</pre>`;
  document.getElementById("copy").onclick = () => copy(M3U);
  document.getElementById("ref").onclick = async () => {
    const x = await j("/live/refresh", { method: "POST" });
    document.getElementById("c").textContent = `${x.count || 0} entries`;
    loadPreview();
  };
  document.getElementById("add").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await j("/live/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: fd.get("name"), url: fd.get("url") }),
    });
    live();
  };
  app.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      await j("/live/sources/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: btn.getAttribute("data-del") }),
      });
      live();
    };
  });
  loadPreview();
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/"/g, """);
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
