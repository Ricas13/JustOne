const app = document.getElementById("app");

async function j(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

function overview(st) {
  const p = st?.paths || {};
  app.innerHTML = `
    <h1>JustOne</h1>
    <p class="muted">First boot writes TRaSH STRM trees and a live M3U. Playback 302s to a CinePro / live URL — no video on this host.</p>
    <div class="panel">
      <p>Folders</p>
      <code>${p.movies1080 || ""}</code><br/>
      <code>${p.movies4k || ""}</code><br/>
      <code>${p.tv1080 || ""}</code><br/>
      <code>${p.tv4k || ""}</code><br/>
      <code>${p.live || ""}/playlist.m3u8</code>
    </div>
    <div class="panel" id="job">Job: ${st?.phase || "…"} · movies ${st?.movies || 0} · episodes ${st?.episodes || 0} · live ${st?.channels || 0}</div>`;
}

function library(st) {
  app.innerHTML = `
    <h1>STRM</h1>
    <p class="muted">TMDB catalog, CinePro resolve at play. 1080p and 4K trees. First run is automatic; this button rebuilds.</p>
    <div class="panel">
      <p id="job">phase ${st?.phase} running=${st?.running} movies=${st?.movies} episodes=${st?.episodes}</p>
      <button id="go">Generate now</button>
    </div>`;
  document.getElementById("go").onclick = async () => {
    await j("/library/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    poll();
  };
}

async function live() {
  const t = await (await fetch("/live/playlist.m3u8")).text();
  app.innerHTML = `<h1>Live M3U</h1>
    <div class="panel"><button id="ref">Refresh from dlhd</button> <span id="c" class="muted"></span></div>
    <pre>${t.slice(0, 12000).replace(/</g, "<")}</pre>`;
  document.getElementById("ref").onclick = async () => {
    const x = await j("/live/refresh", { method: "POST" });
    document.getElementById("c").textContent = `${x.count || 0} → ${x.file || ""}`;
  };
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
}, 4000);
