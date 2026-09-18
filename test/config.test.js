import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

test("custom listener ports propagate into default internal URLs", () => {
  const script = [
    'import { config } from "./src/config.js";',
    'console.log(JSON.stringify({ port: config.port, internalPort: config.internalPort, internalBaseUrl: config.internalBaseUrl }));',
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "9100",
      INTERNAL_PORT: "9101",
      INTERNAL_BASE_URL: "",
    },
    encoding: "utf8",
  }).trim();
  assert.deepEqual(JSON.parse(output), {
    port: 9100,
    internalPort: 9101,
    internalBaseUrl: "http://justone-catalog:9101",
  });
});

test("docker compose routes configured admin and internal ports instead of hard-coded defaults", () => {
  const compose = fs.readFileSync("docker-compose.yml", "utf8");
  assert.match(compose, /127\.0\.0\.1:\$\{PORT:-8090\}:\$\{PORT:-8090\}/);
  assert.match(compose, /\$\{INTERNAL_PORT:-8091\}/);
  assert.match(compose, /loadbalancer\.server\.port=\$\{PORT:-8090\}/);
});
