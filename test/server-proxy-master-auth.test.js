import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test("proxied master M3U requires the stream key after cutover", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-master-auth-"));
  process.env.DATA_DIR = dataDir;
  process.env.STREAM_PROXY_ENABLED = "true";
  process.env.STREAM_PROXY_MASTER_ENABLED = "true";
  process.env.STREAM_PROXY_KEY = "stream-secret";
  process.env.INTERNAL_KEY = "";

  const { createInternalServer, streamManager } = await import("../src/server.js");
  const server = createInternalServer();
  const base = await listen(server);
  t.after(async () => {
    streamManager.shutdown();
    await close(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/m3u/master.m3u`)).status, 401);
  const response = await fetch(`${base}/m3u/master.m3u?key=stream-secret`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^#EXTM3U/m);

  // EPG remains on the legacy/internal-output auth boundary.
  assert.equal((await fetch(`${base}/epg/guide.xml`)).status, 200);
});
