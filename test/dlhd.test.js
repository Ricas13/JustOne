import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDlhdReference,
  filterSourceRowsByDlhd,
  parse247Html,
  parseProtectedSchedule,
  parseScheduleHtml,
} from "../src/dlhd.js";

test("parses 24/7 channels", () => {
  const html = '<a href="/watch.php?id=35"><div class="card__title">BBC One UK</div></a><a href="/watch.php?id=36"><div class="card__title">Sky Sports Football UK</div></a>';
  assert.deepEqual(parse247Html(html).map((x) => x.name), ["BBC One UK", "Sky Sports Football UK"]);
});

test("parses public schedule events and linked channels", () => {
  const html = `<div>Sunday 13th Sep 2026 - Schedule Time UK GMT</div><div class="card__meta">All Soccer Events ⚽</div><span>11:00</span><div class="schedule__eventTitle">England - Championship : Sheffield United vs Wolverhampton Wanderers</div><a href="/watch.php?id=66">Sky Sports Football UK</a><a href="/watch.php?id=134">Event Stream</a>`;
  const out = parseScheduleHtml(html);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].channels[0].name, "Sky Sports Football UK");
  assert.ok(out.events[0].start);
});

test("protected schedule parser reads channels and channels2", () => {
  const out = parseProtectedSchedule({ data: { "Sunday 13th Sep 2026": { Football: [{ time: "11:00", event: "A vs B", channels: [{ channel_name: "Sky Sports Football UK", channel_id: "66" }], channels2: [{ channel_name: "Alt", channel_id: "77" }] }] } } });
  assert.equal(out.events[0].channels.length, 2);
});

test("filters IPTV rows to DLHD channel and event catalogue", () => {
  const schedule = parseScheduleHtml(`<div>Sunday 13th Sep 2026 - Schedule Time UK GMT</div><div class="card__meta">Football</div><span>11:00</span><div class="schedule__eventTitle">Sheffield United vs Wolverhampton Wanderers</div><a href="/watch.php?id=66">Sky Sports Football UK</a>`);
  const reference = buildDlhdReference({ channels: [{ id: "35", name: "BBC One UK" }], schedule });
  const sourceRows = [
    { source: { id: "a" }, row: { name: "UK: BBC One FHD", tvgName: "BBC One FHD" } },
    { source: { id: "a" }, row: { name: "Sky Sports Football HD", tvgName: "Sky Sports Football UK" } },
    { source: { id: "a" }, row: { name: "Random Shopping TV" } },
  ];
  const filtered = filterSourceRowsByDlhd(sourceRows, reference);
  assert.equal(filtered.matchedInputRows, 2);
  assert.equal(filtered.rows.filter((x) => x.reference.kind === "channel").length, 1);
  assert.equal(filtered.rows.filter((x) => x.reference.kind === "event").length, 1);
  assert.equal(filtered.unmatchedReferences.length, 0);
});
