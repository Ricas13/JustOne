const TMDB = "https://image.tmdb.org/t/p";
const p = (path) => `${TMDB}/w500${path}`;
const b = (path) => `${TMDB}/w1280${path}`;
const BBB = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
const HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

const movies = [
  { id: "m-dune2", tmdbId: 693134, kind: "movie", title: "Dune: Part Two", year: 2024, poster: p("/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg"), backdrop: b("/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg"), overview: "Paul Atreides unites with the Fremen.", rating: 8.3, sampleUrl: BBB },
  { id: "m-interstellar", tmdbId: 157336, kind: "movie", title: "Interstellar", year: 2014, poster: p("/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg"), backdrop: b("/xJHokMblPvKWHD8LJJTUfo0VAon.jpg"), overview: "Explorers travel through a wormhole.", rating: 8.7, sampleUrl: BBB },
  { id: "m-oppenheimer", tmdbId: 872585, kind: "movie", title: "Oppenheimer", year: 2023, poster: p("/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"), backdrop: b("/rLb2cwF3Pazuxaj0sRXQ037tGI1.jpg"), overview: "The story of J. Robert Oppenheimer.", rating: 8.2, sampleUrl: BBB },
  { id: "m-dark-knight", tmdbId: 155, kind: "movie", title: "The Dark Knight", year: 2008, poster: p("/qJ2tW6WMUDux911r6m7haRef0WH.jpg"), backdrop: b("/hqkIcbrOHL86UncnHIsHVcVmzue.jpg"), overview: "Batman faces the Joker.", rating: 9.0, sampleUrl: BBB },
  { id: "m-inception", tmdbId: 27205, kind: "movie", title: "Inception", year: 2010, poster: p("/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg"), backdrop: b("/s3TBrRGB1iav7gFOCNx3H31MoES.jpg"), overview: "A thief enters dreams.", rating: 8.8, sampleUrl: BBB },
  { id: "m-parasite", tmdbId: 496243, kind: "movie", title: "Parasite", year: 2019, poster: p("/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg"), backdrop: b("/hiKmpZMGZsrkA3cdce8a7Dpos1j.jpg"), overview: "Two families, one house.", rating: 8.5, sampleUrl: BBB },
];

const series = [
  { id: "s-severance", tmdbId: 95396, kind: "series", title: "Severance", year: 2022, poster: p("/lFf6LLrQjYln8WCguu1UZnqYJS3.jpg"), backdrop: b("/kU98MbTG4X8nWl5CqbCu2l2Kpr5.jpg"), overview: "Work memories, split.", rating: 8.4, sampleUrl: BBB },
  { id: "s-shogun", tmdbId: 121223, kind: "series", title: "Shōgun", year: 2024, poster: p("/7O4iVfOMQ1T1nTeswYVzy6b6WxO.jpg"), backdrop: b("/6Y9ftFwbz01g5n3tHpHv4rUk650.jpg"), overview: "A shipwreck in 1600 Japan.", rating: 8.7, sampleUrl: BBB },
  { id: "s-andor", tmdbId: 83867, kind: "series", title: "Andor", year: 2022, poster: p("/59SVNwL8tjTEdgzljjB3soT5iAl.jpg"), backdrop: b("/iHSwvRVsRyxpX7FE7GbviaDvgAZ.jpg"), overview: "The making of a rebel.", rating: 8.4, sampleUrl: BBB },
  { id: "s-the-bear", tmdbId: 136315, kind: "series", title: "The Bear", year: 2022, poster: p("/sHFlbKS3WLqMnp9t2ghADIJFnuQ.jpg"), backdrop: b("/9faGSFi5IakII6fGZvz1vd4EM3E.jpg"), overview: "A chef returns home.", rating: 8.6, sampleUrl: BBB },
];

const demoChannels = [
  { id: "1", name: "News 24", group: "News" },
  { id: "2", name: "Sports One", group: "Sports" },
  { id: "3", name: "Matchday", group: "Sports" },
  { id: "4", name: "Cinema 1", group: "Movies" },
  { id: "5", name: "Docs", group: "Factual" },
  { id: "6", name: "Kids", group: "Kids" },
  { id: "7", name: "Music Mix", group: "Music" },
  { id: "8", name: "Late Night", group: "Entertainment" },
];

const all = [...movies, ...series];
const app = document.getElementById("app");
const health = { cinepro: false, live: false };

async function loadHealth() {
  try {
    const r = await fetch("/health");
    const j = await r.json();
    health.cinepro = Boolean(j.checks?.cinepro?.ok);
    health.live = Boolean(j.checks?.dlhd?.ok);
  } catch { /* demo */ }
}

async function loadChannels() {
  try {
    const r = await fetch("/live/channels");
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.channels || [];
    if (list.length) return list.map((c) => ({ id: String(c.id), name: c.name, group: c.group || "Live" }));
  } catch { /* demo */ }
  return demoChannels;
}

function nav(active) {
  const items = [
    ["#/", "Home"],
    ["#/movies", "Movies"],
    ["#/live", "Live"],
    ["#/library", "Library"],
    ["#/setup", "Setup"],
  ];
  return `
    <header class="top">
      <a class="brand" href="#/">JustOne</a>
      <nav class="nav">${items.map(([h, l]) => `<a href="${h}" class="${active===h?"on":""}">${l}</a>`).join("")}</nav>
      <a href="#/search" style="margin-left:auto;color:var(--muted);font-size:14px">Search</a>
    </header>
    <nav class="bottom">${items.map(([h, l]) => `<a href="${h}" class="${active===h?"on":""}">${l}</a>`).join("")}</nav>
  `;
}

function poster(t) {
  return `<a class="card" href="#/title/${t.kind}/${t.id}">
    <img src="${t.poster}" alt="" onerror="this.style.opacity=.2" />
    <p>${t.title}</p>
  </a>`;
}

function home() {
  const hero = movies[0];
  app.innerHTML = `${nav("#/")}
    <div class="wrap">
      <section class="hero">
        <img src="${hero.backdrop}" alt="" />
        <div class="shade"></div>
        <div class="copy">
          <p class="muted" style="letter-spacing:.18em;font-size:12px;text-transform:uppercase">Tonight</p>
          <h1 style="font-size:48px">${hero.title}</h1>
          <p class="muted">${hero.overview}</p>
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
            <a class="btn" href="#/watch/${hero.kind}/${hero.id}">Play</a>
            <a class="btn ghost" href="#/live">Live TV</a>
          </div>
        </div>
      </section>
      <h2 class="muted" style="font-size:14px;margin:32px 0 12px">Movies</h2>
      <div class="row">${movies.map(poster).join("")}</div>
      <h2 class="muted" style="font-size:14px;margin:32px 0 12px">Series</h2>
      <div class="row">${series.map(poster).join("")}</div>
    </div>`;
}

function moviesPage() {
  app.innerHTML = `${nav("#/movies")}<div class="wrap">
    <h1>Movies & series</h1>
    <p class="muted">When CinePro is connected, Play resolves sources. Demo playback always works.</p>
    <div class="grid" style="margin-top:24px">${all.map(poster).join("")}</div>
  </div>`;
}

async function livePage() {
  const channels = await loadChannels();
  app.innerHTML = `${nav("#/live")}<div class="wrap">
    <h1>Live TV</h1>
    <p class="muted">${health.live ? "Channels from your live resolver." : "Demo channels — connect dlhd-web for a full list."}</p>
    <div style="display:grid;gap:8px;margin-top:20px">
      ${channels.map((c) => `<a class="channel" href="#/watch/live/${c.id}">
        <span>${c.name}</span><span class="muted" style="font-size:12px">${c.group || ""}</span>
        <span class="live">Live</span>
      </a>`).join("")}
    </div>
  </div>`;
}

function titlePage(kind, id) {
  const t = all.find((x) => x.kind === kind && x.id === id);
  if (!t) { app.innerHTML = `${nav("#/")} <div class="wrap">Not found</div>`; return; }
  app.innerHTML = `${nav("#/movies")}<div class="wrap" style="display:grid;gap:24px;grid-template-columns:minmax(0,180px) 1fr">
    <img src="${t.poster}" style="border-radius:12px" alt="" />
    <div>
      <p class="muted" style="text-transform:uppercase;letter-spacing:.16em;font-size:12px">${t.kind} · ${t.year}</p>
      <h1 style="font-size:40px">${t.title}</h1>
      <p>${t.overview}</p>
      <div style="display:flex;gap:8px;margin-top:16px">
        <a class="btn" href="#/watch/${t.kind}/${t.id}">Play</a>
        <button class="btn ghost" id="strm">Write STRM</button>
      </div>
      <p class="mono" id="strm-path" style="margin-top:12px"></p>
    </div>
  </div>`;
  document.getElementById("strm").onclick = async () => {
    const body = { title: t.title, year: t.year, tmdbId: t.tmdbId, streamUrl: t.sampleUrl };
    try {
      const r = await fetch("/library/movie", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      document.getElementById("strm-path").textContent = j.filePath || j.error || "saved";
    } catch {
      document.getElementById("strm-path").textContent = `library/movies/${t.title} (${t.year})/${t.title} (${t.year}).strm`;
    }
  };
}

function watchPage(kind, id) {
  const t = all.find((x) => x.kind === kind && x.id === id);
  const src = kind === "live" ? `/proxy/live/${id}` : (t?.sampleUrl || BBB);
  const name = t?.title || `Channel ${id}`;
  app.innerHTML = `<div class="player">
    <a class="back" href="${kind === "live" ? "#/live" : "#/"}">Back</a>
    <video src="${kind === "live" && !health.live ? HLS : src}" controls autoplay playsinline></video>
  </div>`;
  document.title = name + " · JustOne";
}

function searchPage() {
  app.innerHTML = `${nav("#/search")}<div class="wrap">
    <h1>Search</h1>
    <input class="search" id="q" placeholder="Titles" />
    <div id="out" class="grid" style="margin-top:20px">${all.map(poster).join("")}</div>
  </div>`;
  document.getElementById("q").oninput = (e) => {
    const n = e.target.value.toLowerCase();
    const hits = all.filter((t) => t.title.toLowerCase().includes(n));
    document.getElementById("out").innerHTML = hits.map(poster).join("");
  };
}

function libraryPage() {
  app.innerHTML = `${nav("#/library")}<div class="wrap">
    <h1>Library</h1>
    <p class="muted">STRM files are written on the server under data/library when you tap Write STRM on a title.</p>
    <div class="panel" style="margin-top:16px"><code>data/library/movies · tv · live</code></div>
  </div>`;
}

function setupPage() {
  const host = location.origin;
  app.innerHTML = `${nav("#/setup")}<div class="wrap">
    <h1>Setup</h1>
    <p class="muted">One addon for Stremio. One M3U for live. STRM for Jellyfin.</p>
    <div class="panel" style="margin-top:20px">
      <p>Stremio manifest</p>
      <code>${host}/stremio/manifest.json</code>
      <p style="margin-top:16px">Live M3U</p>
      <code>${host}/live/playlist.m3u8</code>
      <p style="margin-top:16px">Health</p>
      <code>CinePro ${health.cinepro ? "up" : "not connected"} · Live ${health.live ? "up" : "demo"}</code>
    </div>
  </div>`;
}

async function route() {
  await loadHealth();
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\//, "").split("/");
  if (hash === "#/" || hash === "") return home();
  if (hash.startsWith("#/movies")) return moviesPage();
  if (hash.startsWith("#/live")) return livePage();
  if (hash.startsWith("#/search")) return searchPage();
  if (hash.startsWith("#/library")) return libraryPage();
  if (hash.startsWith("#/setup")) return setupPage();
  if (parts[0] === "title") return titlePage(parts[1], parts[2]);
  if (parts[0] === "watch") return watchPage(parts[1], parts[2]);
  home();
}

window.addEventListener("hashchange", route);
route();
