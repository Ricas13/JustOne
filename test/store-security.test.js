import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("persisted state, snapshot, guide and provider metadata use private file permissions", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "justone-store-mode-"));
  try {
    const script = [
      'import { saveGuide, saveProviderCacheMeta, saveSnapshot, saveState } from "./src/store.js";',
      'await saveState({ version:1, sources:[{id:"s",url:"http://u:p@example/live"}], guides:[], aliases:{}, overrides:{} });',
      'await saveSnapshot({ generatedAt:null, channels:[{ variants:[{ url:"http://u:p@example/live/1" }] }] });',
      'await saveGuide("<tv></tv>");',
      'await saveProviderCacheMeta("s", { url:"http://u:p@example/get.php" });',
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDir },
      stdio: "pipe",
    });

    for (const file of [
      path.join(dataDir, "state.json"),
      path.join(dataDir, "snapshot.json"),
      path.join(dataDir, "guide.xml"),
      path.join(dataDir, "provider-cache", "s.json"),
    ]) {
      const mode = (await fs.stat(file)).mode & 0o777;
      assert.equal(mode, 0o600, `${file} should be owner-readable/writable only`);
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
