const app = document.getElementById("app");
const M3U = `${location.origin}/live/playlist.m3u8`;

async function j(path, opts) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (r.status === 401) {
    location.href = "/login";
    return {};
  }
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t, status: r.status };
  }
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/"/g, "&" + "quot;");
}

function copy(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function urlBox(id, label, url) {
  return `
    <p>${label}</p>
    <input id="${id}" class="url" type="text" readonly value="${esc(url)}" />
    <p><button type="button" data-copy-from="${id}">Copy</button></p>`;
}

function bindCopies() {
  app.querySelectorAll("[data-copy-from]").forEach((btn) => {
    btn.onclick = () => {
      const el = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!el) return;
      el.select();
      copy(el.value);
    };
  });
}

function overview(st, links) {
  const p = st?.paths || {};
  const all = links?.all || M3U;
  app.innerHTML = `
    <h1>JustOne</h1>
    <p class="muted">Admin only. Jellyfin / VLC use the public play URLs — origin stays hidden.</p>
    <div class="panel">
      ${urlBox("m3u", "IPTV playlist (paste this in Jellyfin / IPTVEditor)", all)}
      <p class="muted">${links?.locked ? "This URL includes PLAYLIST_KEY." : "Set PLAYLIST_KEY in .env to lock public play URLs."}</p>
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
  bindCopies();
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
    await j("/library/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    poll();
  };
}

async function live() {
  const links = await j("/live/links");
  const origin = location.origin;
  const tv = links.tv || `${origin}/live/247.m3u8`;
  const sports = links.sports || `${origin}/live/sports.m3u8`;
  const extra = links.extra || `${origin}/live/extra.m3u8`;
  const all = links.all || M3U;
  const sources = await j("/live/sources");
  const rows = (Array.isArray(sources) ? sources : [])
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="muted">${esc(s.url)}</td><td><button type="button" data-del="${esc(s.id)}">Remove</button></td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <h1>Live IPTV</h1>
    <p class="muted">Use <b>24/7</b> as the main Jellyfin tuner (grouped by country). Add <b>Sports</b> as a second tuner if you want today’s matches.${links.locked ? " URLs include a secret key — don’t share them." : " Set PLAYLIST_KEY in .env to lock these URLs."}</p>
    <div class="panel">
      ${urlBox("u-tv", "24/7 (Jellyfin — start with this)", tv)}
      ${urlBox("u-sports", "Sports events", sports)}
      ${urlBox("u-extra", "Extra sources", extra)}
      ${urlBox("u-all", "Everything", all)}
      <p><button type="button" id="ref">Refresh all sources</button>
         <span id="c" class="muted"></span></p>
    </div>
    <div class="panel">
      <h2>Extra M3U sources</h2>
      <p class="muted">Add a playlist URL. Group title becomes the source name.</p>
      <form id="add">
        <input name="name" placeholder="Name" required />
        <input name="url" type="url" placeholder="https://…/playlist.m3u8" required />
        <button type="submit">Add source</button>
      </form>
      <table>${rows || "<tr><td class=muted>No extra sources yet.</td></tr>"}</table>
    </div>
    <pre id="preview">Loading…</pre>`;
  bindCopies();
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

async function health() {
  const h = await j("/health");
  app.innerHTML = `<h1>Health</h1><pre>${esc(JSON.stringify(h, null, 2))}</pre>`;
}

async function loadPreview() {
  const r = await fetch("/live/playlist.m3u8", { credentials: "same-origin" });
  const t = await r.text();
  const el = document.getElementById("preview");
  if (el) el.textContent = t.slice(0, 8000);
}

async function poll() {
  try {
    const st = await j("/library/status");
    const links = await j("/live/links");
    const h = location.hash || "#/";
    if (h.startsWith("#/library")) library(st);
    else if (h.startsWith("#/live")) await live();
    else if (h.startsWith("#/health")) await health();
    else overview(st, links);
  } catch (e) {
    app.innerHTML = `<h1>Dashboard</h1><p class="muted">${esc(String(e.message || e))}</p>`;
  }
}

window.addEventListener("hashchange", poll);
poll();
setInterval(() => {
  if (!(location.hash || "#/").startsWith("#/live")) poll();
}, 8000);