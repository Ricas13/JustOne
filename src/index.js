import { config } from "./config.js";
import { refreshCatalog } from "./catalog.js";
import { createAdminServer, createInternalServer } from "./server.js";

const adminServer = createAdminServer();
const internalServer = createInternalServer();

adminServer.listen(config.port, config.bindAddress, () => {
  console.log(`JustOne admin listening on ${config.bindAddress}:${config.port}`);
});
internalServer.listen(config.internalPort, config.internalBindAddress, () => {
  console.log(`JustOne internal outputs listening on ${config.internalBindAddress}:${config.internalPort} (not published by docker-compose)`);
});

let refreshing = false;
async function scheduledRefresh(reason) {
  if (refreshing) return;
  refreshing = true;
  try {
    const snapshot = await refreshCatalog();
    console.log(`Catalog refresh (${reason}) complete: ${snapshot.channels.length} channels; DLHD ${snapshot.dlhdStatus?.matchedReferences ?? "off"}/${snapshot.dlhdStatus?.totalReferences ?? "off"} references matched`);
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
  process.on(signal, () => {
    let pending = 2;
    const done = () => { if (--pending <= 0) process.exit(0); };
    adminServer.close(done);
    internalServer.close(done);
  });
}
