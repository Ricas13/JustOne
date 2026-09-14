import { config } from "./config.js";
import { refreshManager } from "./refresh-manager.js";
import { createAdminServer, createInternalServer } from "./server.js";

if (!config.adminKey) {
  console.error("ADMIN_KEY is required because the admin/API listener may be exposed through Traefik.");
  process.exit(1);
}

const adminServer = createAdminServer();
const internalServer = createInternalServer();

adminServer.listen(config.port, config.bindAddress, () => {
  console.log(`JustOne admin listening on ${config.bindAddress}:${config.port}`);
});
internalServer.listen(config.internalPort, config.internalBindAddress, () => {
  console.log(`JustOne internal outputs listening on ${config.internalBindAddress}:${config.internalPort} (not published by docker-compose)`);
});

console.log(`Refresh cadence: providers every ${config.providerRefreshMinutes} min; DLHD every ${config.dlhdRefreshMinutes} min`);

// Startup uses a fresh provider cache if available, otherwise it downloads the
// provider M3U and creates the cache. This avoids a huge re-download on every
// container restart while still self-healing when no cache exists.
setTimeout(() => refreshManager.start("startup", { sourceMode: "auto" }), 250);

// Register the daily provider timer first. At the 24h boundary it also fetches
// fresh DLHD, so if the 8h timer fires on the same tick it can safely skip.
if (config.providerRefreshMinutes > 0) {
  setInterval(() => {
    const result = refreshManager.start("provider-scheduled", { sourceMode: "network" });
    if (!result.started) console.log("Provider refresh skipped because another refresh is still running");
  }, config.providerRefreshMinutes * 60 * 1000).unref();
}

if (config.dlhdRefreshMinutes > 0) {
  setInterval(() => {
    const result = refreshManager.start("dlhd-scheduled", { sourceMode: "cache" });
    if (!result.started) console.log("DLHD refresh skipped because another refresh is still running");
  }, config.dlhdRefreshMinutes * 60 * 1000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    let pending = 2;
    const done = () => { if (--pending <= 0) process.exit(0); };
    adminServer.close(done);
    internalServer.close(done);
  });
}
