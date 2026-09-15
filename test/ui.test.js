import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_HTML } from "../src/ui.js";

test("admin UI exposes a safety-gated Dispatcharr apply control", () => {
  assert.match(ADMIN_HTML, /id="applyDispatcharrButton"[^>]*disabled/);
  assert.match(ADMIN_HTML, /fresh\.readyForApply/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/preview/);
  assert.match(ADMIN_HTML, /\/api\/dispatcharr\/reconcile/);
  assert.match(ADMIN_HTML, /JSON\.stringify\(\{apply:true\}\)/);
  assert.match(ADMIN_HTML, /confirm\(warning\)/);
  assert.match(ADMIN_HTML, /await previewDispatcharr\(\)/);
});

test("embedded admin script remains syntactically valid", () => {
  const match = ADMIN_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "admin script should be present");
  assert.doesNotThrow(() => new Function(match[1]));
});
