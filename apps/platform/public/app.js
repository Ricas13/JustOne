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

async function maybe(path) {
  try {
    const r = await fetch(path, { credentials: "same-origin" });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
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

function urlBox(id, label, url, note = "") {
  return `
    <p><b>${esc(label)}</b>${note ? ` <span class="muted">— ${esc(note)}</span>` : ""}</p>
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

function siblingUrl(source, pathname) {
  try {
    const u = new URL(source || M3U, location.origin);
    u.pathname = pathname;
    u.hash = "";
    return u.href;
  } catch {
    return `${location.origin}${pathname}`;
  }
}

function enhancedUrls(links) {
  const raw = links?.all || M3U;
  return {
    playlist: siblingUrl(raw, "/jellyfin/playlist.m3u8"),
    guide: siblingUrl(raw, "/jellyfin/guide.xml"),
  };
}

function overview(st, links) {
  const p = st?.paths || {};
  const raw = links?.all || M3U;
  const enhanced = enhancedUrls(links);
  app.innerHTML = `
    <h1>JustOne</h1>
    <p class="muted">Admin only. The Jellyfin feed improves metadata only; playback stays on the original /play/live URLs.</p>
    <div class="panel">
      <h2>Jellyfin Enhanced</h2>
      ${urlBox("jf-m3u", "M3U tuner", enhanced.playlist, "logos, EPG, naming and Jellyfin ordering")}
      ${urlBox("jf-epg", "XMLTV guide", enhanced.guide, "programme titles, event cards and artwork")}
      <p class="muted">18+, Free Channels, IPTV-Org source rows and VOD groups are excluded here only.</p>
    </div>
    <div class="panel">
      <h2>Raw / Emergency</h2>
      ${urlBox("m3u", "Original Grok-compatible M3U", raw, "known-good transport; never beautified")}
      <p class="muted">${links?.locked ? "URLs include PLAYLIST_KEY — don’t share them." : "Set PLAYLIST_KEY in .env to lock public play URLs."}</p>
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
  const [links, sources, jellyfin] = await Promise.all([
    j("/live/links"),
    j("/live/sources"),
    maybe("/jellyfin/health"),
  ]);
  const origin = location.origin;
  const tv = links.tv || `${origin}/live/247.m3u8`;
  const sports = links.sports || `${origin}/live/sports.m3u8`;
  const extra = links.extra || `${origin}/live/extra.m3u8`;
  const all = links.all || M3U;
  const enhanced = enhancedUrls(links);
  const rows = (Array.isArray(sources) ? sources : [])
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="muted">${esc(s.url)}</td><td><button type="button" data-del="${esc(s.id)}">Remove</button></td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <h1>Live IPTV</h1>
    <p class="muted">Use the enhanced pair in Jellyfin. It only changes presentation metadata; every accepted channel keeps its original working playback URL.</p>
    <div class="panel">
      <h2>Jellyfin Enhanced</h2>
      ${urlBox("u-jf", "M3U tuner", enhanced.playlist, `${jellyfin?.channels || 0} organised channels`)}
      ${urlBox("u-epg", "XMLTV guide", enhanced.guide, `${jellyfin?.epgSources || 0} loaded guide sources`)}
      <p class="muted">Sports first, then USA, UK, Portugal and other countries; standard channel ordering, renamed channels, official/generated logos and programme artwork.</p>
      <p class="muted">Filtered from this view only: 18+, Free Channels/providers, IPTV-Org source rows and VOD groups.</p>
    </div>
    <div class="panel">
      <h2>Raw / Emergency feeds</h2>
      ${urlBox("u-all", "Everything", all, "original transport")}
      ${urlBox("u-tv", "24/7", tv)}
      ${urlBox("u-sports", "Sports events", sports)}
      ${urlBox("u-extra", "Extra sources", extra)}
      <p><button type="button" id="ref">Refresh all sources</button>
         <span id="c" class="muted"></span></p>
    </div>
    <div class="panel">
      <h2>Extra M3U sources</h2>
      <p class="muted">Add a playlist URL. Group title becomes the source name.</p>
      <form id="add">
        <input name="name" list="hints" placeholder="Name (e.g. VAVOO)" required />
        <input name="url" type="url" placeholder="https://…/playlist.m3u8" required />
        <button type="submit">Add source</button>
      </form>
      <datalist id="hints"><option value="Toonami Aftermath"></option></datalist>
      <table>${rows || "<tr><td class=muted>No extra sources yet.</td></tr>"}</table>
    </div>
    <pre id="preview">Loading raw transport preview…</pre>`;
  bindCopies();
  document.getElementById("ref").onclick = async () => {
    const x = await j("/live/refresh", { method: "POST" });
    document.getElementById("c").textContent = `${x.count || 0} entries`;
    loadPreview(all);
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
  loadPreview(all);
}

async function health() {
  const [h, jf] = await Promise.all([j("/health"), maybe("/jellyfin/health")]);
  app.innerHTML = `<h1>Health</h1><pre>${esc(JSON.stringify({ platform: h, jellyfin: jf }, null, 2))}</pre>`;
}

async function loadPreview(url = "/live/playlist.m3u8") {
  const r = await fetch(url, { credentials: "same-origin" });
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
