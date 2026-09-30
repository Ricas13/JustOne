import test from "node:test";
import assert from "node:assert/strict";
import { protectLastKnownGoodGuide } from "../src/catalog.js";

const healthy = `<?xml version="1.0"?><tv generator-info-name="JustOne Catalog">
  <channel id="justone.bbc"><display-name>BBC One</display-name></channel>
  <programme start="20260930090000 +0000" stop="20260930100000 +0000" channel="justone.bbc"><title>News</title></programme>
  <programme start="20260930100000 +0000" stop="20260930110000 +0000" channel="justone.bbc"><title>Morning Live</title></programme>
</tv>`;

const emptyCandidate = `<?xml version="1.0"?><tv generator-info-name="JustOne Catalog">
  <channel id="justone.bbc"><display-name>BBC One</display-name></channel>
</tv>`;

test("failed upstream EPG refresh preserves the last known good generated guide", () => {
  const result = protectLastKnownGoodGuide(healthy, emptyCandidate, [
    { id: "guide-1", ok: false, error: "provider offline" },
  ]);

  assert.equal(result.preserved, true);
  assert.equal(result.xml, healthy);
  assert.equal(result.failedGuides, 1);
  assert.equal(result.previousProgrammes, 2);
  assert.equal(result.nextProgrammes, 0);
});

test("successful EPG refresh is allowed to replace the previous guide", () => {
  const next = healthy.replace("Morning Live", "Updated Programme");
  const result = protectLastKnownGoodGuide(healthy, next, [
    { id: "guide-1", ok: true },
  ]);

  assert.equal(result.preserved, false);
  assert.equal(result.xml, next);
  assert.equal(result.failedGuides, 0);
});

test("first-run guide generation is not blocked when there is no previous programme data", () => {
  const previous = '<?xml version="1.0"?><tv generator-info-name="JustOne Catalog"></tv>';
  const next = healthy;
  const result = protectLastKnownGoodGuide(previous, next, [
    { id: "guide-1", ok: false, error: "secondary guide failed" },
  ]);

  assert.equal(result.preserved, false);
  assert.equal(result.xml, next);
});
