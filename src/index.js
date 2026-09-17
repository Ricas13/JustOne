import { createArtworkServer } from "./artwork-server.js";
import { config } from "./config.js";
import { refreshManager } from "./refresh-manager.js";
import { createAdminServer, createInternalServer, streamManager } from "./server.js";

if (!config.adminKey) {
  console.error("ADMIN_KEY is required because the admin/API listener may be exposed through Traefik.");
  process.exit(1);
}
if (config.streamProxy.enabled && !config.internalKey) {
  console.error("INTERNAL_KEY is required when STREAM_PROXY_ENABLED=true so internal M3U and stream URLs remain bearer-protected.");
  process.exit(1);
}

const adminServer = createAdminServer();
const internalServer = createInternalServer();
const artworkServer = createArtworkServer();
const artworkPort = config.internalPort + 1;

adminServer.listen(config.port, config.bindAddress, () => {
  console.log(`JustOne admin listening on ${config.bindAddress}:${config.port}`);
});
internalServer.listen(config.internalPort, config.internalBindAddress, () => {
  console.log(`JustOne internal outputs listening on ${config.internalBindAddress}:${config.internalPort} (not published by docker-compose)`);
});
artworkServer.listen(artworkPort, config.internalBindAddress, () => {
  console.log(`JustOne event artwork listening on ${config.internalBindAddress}:${artworkPort} (media_net only)`);
});

console.log(`Refresh cadence: providers every ${config.providerRefreshMinutes} min; DLHD every ${config.dlhdRefreshMinutes} min`);
console.log(`Native stream proxy: ${config.streamProxy.enabled ? "enabled" : "disabled"}; master M3U mode: ${config.streamProxy.enabled && config.streamProxy.masterEnabled ? "proxy" : "legacy variants"}`);

setTimeout(() => refreshManager.start("startup", { sourceMode: "auto" }), 250);

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
    streamManager.shutdown();
    let pending = 3;
    const done = () => { if (--pending <= 0) process.exit(0); };
    adminServer.close(done);
    internalServer.close(done);
    artworkServer.close(done);
  });
}
