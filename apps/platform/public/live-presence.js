const POLL_MS = 3000;

function number(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function updatePresence(stats) {
  const active = Number(stats?.active || 0);
  const channels = Number(stats?.uniqueChannels || 0);
  const presence = document.getElementById("stream-presence");
  if (presence) presence.classList.toggle("live", active > 0);

  const count = document.getElementById("active-stream-count");
  if (count) count.textContent = number(active);

  const detail = document.getElementById("active-stream-detail");
  if (detail) {
    detail.textContent = active
      ? `${number(channels)} active channel${channels === 1 ? "" : "s"}`
      : "No viewers right now";
  }

  document.querySelectorAll("[data-active-stream-count]").forEach((el) => {
    el.textContent = number(active);
  });
  document.querySelectorAll("[data-active-channel-count]").forEach((el) => {
    el.textContent = `${number(channels)} channel${channels === 1 ? "" : "s"}`;
  });
}

function ensureMetric(stats) {
  const route = location.hash || "#/";
  if (!(route === "#/" || route === "" || route.startsWith("#/health"))) return;
  const grid = document.querySelector("main .metric-grid");
  if (!grid) return;

  let metric = document.getElementById("active-stream-metric");
  if (!metric) {
    metric = document.createElement("div");
    metric.id = "active-stream-metric";
    metric.className = "metric";
    metric.innerHTML = `
      <span class="metric-label">Active streams</span>
      <strong data-active-stream-count>0</strong>
      <span class="muted tiny" data-active-channel-count>0 channels</span>`;
    grid.prepend(metric);
  }
  updatePresence(stats);
}

async function refresh() {
  try {
    const response = await fetch("/live/streams", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return;
    const stats = await response.json();
    ensureMetric(stats);
    updatePresence(stats);
  } catch {
    /* dashboard telemetry is best-effort and must never affect playback */
  }
}

const observer = new MutationObserver(() => {
  refresh().catch(() => {});
});
const app = document.getElementById("app");
if (app) observer.observe(app, { childList: true });

window.addEventListener("hashchange", () => refresh().catch(() => {}));
refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), POLL_MS);
