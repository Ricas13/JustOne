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

setTimeout(() => refreshManager.start("startup"), 250);
if (config.refreshMinutes > 0) {
  setInterval(() => {
    const result = refreshManager.start("scheduled");
    if (!result.started) console.log("Scheduled refresh skipped because another refresh is still running");
  }, config.refreshMinutes * 60 * 1000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    let pending = 2;
    const done = () => { if (--pending <= 0) process.exit(0); };
    adminServer.close(done);
    internalServer.close(done);
  });
}
