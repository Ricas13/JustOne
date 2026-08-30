import test from "node:test";
import assert from "node:assert/strict";
import { advanceCatalogCursor, healthFailureDecision } from "../src/catalog.js";

test("catalog cursor walks pages, then years, then starts a new cycle", () => {
  assert.deepEqual(
    advanceCatalogCursor({ year: 2026, page: 3, cycle: 0 }, 5, 2020, 2026),
    { year: 2026, page: 4, cycle: 0 },
  );
  assert.deepEqual(
    advanceCatalogCursor({ year: 2026, page: 5, cycle: 0 }, 5, 2020, 2026),
    { year: 2025, page: 1, cycle: 0 },
  );
  assert.deepEqual(
    advanceCatalogCursor({ year: 2020, page: 1, cycle: 2 }, 1, 2020, 2026),
    { year: 2026, page: 1, cycle: 3 },
  );
});

test("health failures require separated misses and an age grace period before quarantine", () => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse("2026-08-01T00:00:00Z");

  const first = healthFailureDecision(null, start, {
    threshold: 3,
    quarantineDays: 7,
    gapHours: 24,
  });
  assert.equal(first.misses, 1);
  assert.equal(first.quarantine, false);

  const tooSoon = healthFailureDecision(first, start + 2 * 60 * 60 * 1000, {
    threshold: 3,
    quarantineDays: 7,
    gapHours: 24,
  });
  assert.equal(tooSoon.misses, 1);
  assert.equal(tooSoon.incremented, false);

  const second = healthFailureDecision(first, start + day, {
    threshold: 3,
    quarantineDays: 7,
    gapHours: 24,
  });
  const third = healthFailureDecision(second, start + 2 * day, {
    threshold: 3,
    quarantineDays: 7,
    gapHours: 24,
  });
  assert.equal(third.misses, 3);
  assert.equal(third.quarantine, false);

  const mature = healthFailureDecision(third, start + 7 * day, {
    threshold: 3,
    quarantineDays: 7,
    gapHours: 24,
  });
  assert.equal(mature.misses, 4);
  assert.equal(mature.quarantine, true);
});
