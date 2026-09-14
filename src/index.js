import { config } from "./config.js";
import { refreshCatalog } from "./catalog.js";
import { createServer } from "./server.js";

const server = createServer();
server.listen(config.port, "0.0.0.0", () => {
  console.log(`JustOne Catalog listening on :${config.port}`);
});

let refreshing = false;
async function scheduledRefresh(reason) {
  if (refreshing) return;
  refreshing = true;
  try {
    const snapshot = await refreshCatalog();
    console.log(`Catalog refresh (${reason}) complete: ${snapshot.channels.length} channels`);
  } catch (error) {
    console.error(`Catalog refresh (${reason}) failed:`, error);
  } finally {
    refreshing = false;
  }
}

setTimeout(() => scheduledRefresh("startup"), 250);
if (config.refreshMinutes > 0) {
  setInterval(() => scheduledRefresh("scheduled"), config.refreshMinutes * 60 * 1000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
