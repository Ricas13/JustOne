import test from "node:test";
import assert from "node:assert/strict";
import { applyEventSchedule, scheduleEventKey } from "../src/event-schedule.js";
import { parseScheduleMetadata } from "../src/organizer.js";

test("provider sports rows inherit the published UK schedule time", () => {
  const html = [
    '<div>Monday 31st August 2026 - Schedule Time UK</div>',
    '<div class="card__meta">Football ⚽</div>',
    '<span>12:30</span><div class="schedule__eventTitle">Chelsea vs Luton Town</div>',
    '<div class="card__meta">Tennis 🎾</div>',
    '<span>15:45</span><div class="schedule__eventTitle">Player A vs Player B</div>',
  ].join("");
  const schedule = parseScheduleMetadata(html);
  const result = applyEventSchedule([
    { id: "a", name: "Chelsea vs Luton Town — Sky Sports Football UK", group: "Football", programmes: [] },
    { id: "b", name: "Player A vs Player B — Event Stream", group: "Tennis", programmes: [] },
  ], schedule);

  assert.equal(result.eventRows, 2);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 0);

  // 31 August is BST, therefore 12:30 UK is 11:30 UTC in XMLTV time.
  assert.equal(new Date(result.lineup[0].programmes[0].start).toISOString(), "2026-08-31T11:30:00.000Z");
  assert.equal(new Date(result.lineup[1].programmes[0].start).toISOString(), "2026-08-31T14:45:00.000Z");
  assert.equal(result.lineup[0].programmes[0].scheduleSource, "dlstreams");
});

test("unmatched events do not get a fabricated current-time programme", () => {
  const schedule = { byEvent: new Map() };
  const result = applyEventSchedule([
    { id: "x", name: "Unknown Cup Final — Event Stream", group: "Football", programmes: [] },
    { id: "linear", name: "Abu Dhabi Sports 1 UAE", group: "UAE", programmes: [] },
  ], schedule);

  assert.equal(result.eventRows, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.unmatched, 1);
  assert.deepEqual(result.lineup[0].programmes, []);
  assert.deepEqual(result.lineup[1].programmes, []);
});

test("schedule event normalization matches punctuation and quality noise", () => {
  assert.equal(
    scheduleEventKey("Chelsea vs. Luton Town HD"),
    scheduleEventKey("Chelsea vs Luton Town"),
  );
});
