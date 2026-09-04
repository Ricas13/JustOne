import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("internal Jellyfin proxy preserves event selector Location redirects", () => {
  assert.match(index, /function proxyOriginal\(base, \{ preserveLocation = false \} = \{\}\)/);
  assert.match(index, /if \(!preserveLocation\) \{\s*delete out\.location;\s*delete out\.Location;\s*\}/);
  assert.match(index, /app\.use\("\/jellyfin", proxyOriginal\(config\.jellyfinLiveUrl, \{ preserveLocation: true \}\)\)/);
});
