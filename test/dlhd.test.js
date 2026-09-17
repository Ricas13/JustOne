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

test("24/7 parser prefers nearby card title over generic watch-link text", () => {
  const html = '<div class="card"><a href="/watch.php?id=35"><span>Watch Now</span></a><div class="card__title">BBC One UK</div></div>';
  assert.deepEqual(parse247Html(html).map((x) => x.name), ["BBC One UK"]);
});

test("24/7 parser resolves a title that appears before the channel link", () => {
  const html = '<div class="card"><div class="card__title">BBC Four UK</div><a href="/watch.php?id=37"><span>Watch Now</span></a></div>';
  assert.deepEqual(parse247Html(html).map((x) => x.name), ["BBC Four UK"]);
});

test("24/7 parser does not borrow an adjacent card title", () => {
  const html = [
    '<div class="card"><div class="card__title">BBC One UK</div><a href="/watch.php?id=35">Watch Now</a></div>',
    '<div class="card"><a href="/watch.php?id=36">Watch Now</a><div class="card__title">RTP 1 Portugal</div></div>',
    '<div class="card"><div class="card__title">ESPN USA</div><a href="/watch.php?id=37">Watch Now</a></div>',
  ].join('');
  assert.deepEqual(parse247Html(html).map((x) => [x.id, x.name]), [
    ["35", "BBC One UK"],
    ["36", "RTP 1 Portugal"],
    ["37", "ESPN USA"],
  ]);
});

test("DLHD static references retain global country metadata and friendly groups", () => {
  const reference = buildDlhdReference({ channels: [
    { id:"35", name:"BBC One UK" },
    { id:"80", name:"RTP 1 Portugal" },
    { id:"99", name:"ESPN USA" },
    { id:"120", name:"Canal+ Foot France" },
    { id:"121", name:"beIN Sports 2 Malaysia" },
  ] });
  assert.deepEqual(reference.channels.map((x) => [x.country, x.group]), [
    ["GB", "TV | UK"],
    ["PT", "TV | PT"],
    ["US", "TV | USA"],
    ["FR", "TV | France"],
    ["MY", "TV | Malaysia"],
  ]);
});

test("events carried by a normal DLHD channel become linear schedule metadata, not duplicate event channels", () => {
  const schedule = {
    events: [{
      id:"evt-1", title:"Arsenal vs Chelsea", category:"Football", start:1000, end:2000,
      channels:[{ id:"66", name:"Sky Sports Football UK" }],
    }],
  };
  const reference = buildDlhdReference({
    channels: [{ id:"66", name:"Sky Sports Football UK" }],
    schedule,
  });
  assert.equal(reference.events.length, 0);
  assert.equal(reference.linearEvents.length, 1);
  assert.equal(reference.linearEvents[0].linkedStaticChannels[0].name, "Sky Sports Football UK");
});

test("standalone PPV/event-stream schedule entries remain event channels", () => {
  const schedule = {
    events: [{
      id:"evt-ppv", title:"UFC 400", category:"PPV Events", start:1000, end:2000,
      channels:[{ id:"9000", name:"Event PPV" }],
    }],
  };
  const reference = buildDlhdReference({
    channels: [{ id:"66", name:"Sky Sports Football UK" }],
    schedule,
  });
  assert.equal(reference.linearEvents.length, 0);
  assert.equal(reference.events.length, 1);
  assert.equal(reference.events[0].name, "UFC 400");
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
    { source: { id: "a" }, row: { name: "UK| BBC 1 FHD", tvgName: "BBC 1 FHD" } },
    { source: { id: "a" }, row: { name: "Sky Sports Football HD", tvgName: "Sky Sports Football UK" } },
    { source: { id: "a" }, row: { name: "Random Shopping TV" } },
  ];
  const filtered = filterSourceRowsByDlhd(sourceRows, reference);
  assert.equal(filtered.matchedInputRows, 2);
  assert.equal(filtered.rows.filter((x) => x.reference.kind === "channel").length, 1);
  assert.equal(filtered.rows.filter((x) => x.reference.kind === "event").length, 1);
  assert.equal(filtered.unmatchedReferences.length, 0);
});
