import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterProviderEvents,
  eventSignature,
  excludeClaimedRows,
  parseProviderEventRow,
  providerEventRetainable,
  resolveProviderEvents,
  sameProviderOccurrence,
  signaturesMatch,
  zonedTimeMs,
} from "../src/provider-events.js";
import { finalizeSnapshot, removeStaleProviderEvents, syncGuideEvents } from "../src/finalize.js";
import { eventArtworkPng } from "../src/artwork.js";
import { config } from "../src/config.js";
import { DEFAULT_PROVIDER_EVENT_GROUPS } from "../src/provider-events.js";

const NOW = Date.UTC(2026, 9, 31, 13, 0, 0); // 2026-10-31 13:00 UTC
const GROUPS = new RegExp(config.providerEvents.groups, "i");
const opts = { now: NOW, timezone: "UTC", groupRe: GROUPS };
const row = (name, group = "AM | USA PPV-LIVE EVENTS") => ({ name, tvgName: name, group, url: `http://p/${encodeURIComponent(name)}` });
const source = (id) => ({ id, name: id, provider: id, maxStreams: 1 });

test("parses titled slot rows with an embedded timestamp", () => {
  const parsed = parseProviderEventRow(row("US| PRIME US 007 [Canelo Alvarez vs. Christian Mbilli (2026-10-31 15:58:00)]"), opts);
  assert.equal(parsed.title, "Canelo Alvarez vs. Christian Mbilli");
  assert.equal(parsed.start, Date.UTC(2026, 9, 31, 15, 58, 0));
  assert.equal(parsed.timeSource, "title-timestamp");
});

test("splits the competition suffix off the title", () => {
  const parsed = parseProviderEventRow(row("ES| DAZN 11 [Canelo vs. Mbilli | Riyadh Season (2026-10-31 14:00:00)]", "EU | SPAIN DAZN"), opts);
  assert.equal(parsed.title, "Canelo vs. Mbilli");
  assert.equal(parsed.competition, "Riyadh Season");
});

test("ignores placeholders and bare channel names", () => {
  for (const name of [
    "US| DAZN US 011 [EVENT ONLY]",
    "PPV| LIVE EVENT 18 [NO EVENT]",
    "AR| BEIN SPORTS 06 HD [BK]",
    "AR| BEIN SPORTS 02 ENGLISH HD [BK1]",
    "SW| MAX+ 8 [LIVE DURING EVENTS ONLY]",
    "US| UFC FIGHT PASS HD",
  ]) assert.equal(parseProviderEventRow(row(name), opts), null, name);
  assert.equal(parseProviderEventRow(row("US| NCAAF 11 [SEC NETWORK]", "AM | USA NCAA"), opts), null);
});

test("event-only group accepts a titled slot without any time", () => {
  const parsed = parseProviderEventRow(row("PPV| LIVE EVENT 26 [MAIN STAGE Live From Coachella 2026]", "VIP | PPV-SPORT EVENTS"), opts);
  assert.equal(parsed.title, "MAIN STAGE Live From Coachella 2026");
  assert.equal(parsed.start, null);
});

test("time of day in the title resolves to the nearest occurrence", () => {
  const am = parseProviderEventRow(row("PPV| LIVE EVENT 02 [10am Canelo v Mbilli]", "VIP | PPV-SPORT EVENTS"), opts);
  assert.equal(am.title, "Canelo v Mbilli");
  assert.equal(am.start, Date.UTC(2026, 9, 31, 10, 0, 0));
  const trailing = parseProviderEventRow(row("PPV| UEFA 02 [Dinamo Zagreb vs NEC Nijmegen 17:45 pm]", "VIP | UEFA PPV"), opts);
  assert.equal(trailing.title, "Dinamo Zagreb vs NEC Nijmegen");
  assert.equal(trailing.start, Date.UTC(2026, 9, 31, 17, 45, 0));
  const late = parseProviderEventRow(row("PPV| LIVE EVENT 07 [10am Ares 44]", "VIP | PPV-SPORT EVENTS"), { ...opts, now: Date.UTC(2026, 9, 31, 23, 30) });
  assert.equal(late.start, Date.UTC(2026, 10, 1, 10, 0, 0), "seen at 23:30, 10am means tomorrow");
});

test("weekday clock times, quality prefixes and generic slot names", () => {
  const wk = parseProviderEventRow(row("PPV| LIVE EVENT 09 [Roosters vs Eels 7:00am Sat]"), opts); // 2026-10-31 is a Saturday
  assert.equal(wk.title, "Roosters vs Eels");
  assert.equal(wk.start, Date.UTC(2026, 9, 31, 7, 0, 0));
  const next = parseProviderEventRow(row("PPV| LIVE EVENT 10 [Dolphins vs Titans 7:15am Sun]"), opts);
  assert.equal(next.start, Date.UTC(2026, 10, 1, 7, 15, 0));
  const dotted = parseProviderEventRow(row("PPV| LIVE EVENT 13 [Celtic vs Hibernian 15.00]"), opts);
  assert.equal(dotted.title, "Celtic vs Hibernian");
  assert.equal(dotted.start, Date.UTC(2026, 9, 31, 15, 0, 0));
  const lead = parseProviderEventRow(row("PPV| LIVE EVENT 14 [20:00 Buckie Thistle vs Dundee United]"), opts);
  assert.equal(lead.title, "Buckie Thistle vs Dundee United");
  const mid = parseProviderEventRow(row("PPV| LIVE EVENT 15 [Celtic 15:00 Dunfermline]"), opts);
  assert.equal(mid.title, "Celtic vs Dunfermline");
  assert.equal(mid.start, Date.UTC(2026, 9, 31, 15, 0, 0));
  assert.equal(parseProviderEventRow(row("PPV| LIVE EVENT 11 [HEVC FHD Eubank Jr vs Benn]"), opts).title, "Eubank Jr vs Benn");
  for (const bad of ["[LIVE-EVENT]", "[BACK-UP]", "[Events Only]", "[NUR WÄHREND DER SPIELE]"]) {
    assert.equal(parseProviderEventRow(row(`PPV| LIVE EVENT 12 ${bad}`), opts), null, bad);
  }
});

test("month/day/time is parsed, with or without the UPCOMING marker, and weekdays are validated", () => {
  const may3 = { ...opts, now: Date.UTC(2026, 4, 3, 12) };
  const marker = parseProviderEventRow(row("US| QMJHL TV 07 [Ronde 3 - Match 6: MON @ ROU * | UPCOMING | Mon May 4th 4:00PM]", "AM | USA LIVE EVENTS"), may3);
  assert.equal(marker.start, Date.UTC(2026, 4, 4, 16, 0, 0));
  const plain = parseProviderEventRow(row("PPV| LIVE EVENT 07 [Mon May 4th 4:00PM Canelo vs Mbilli]"), may3);
  assert.equal(plain.title, "Canelo vs Mbilli");
  assert.equal(plain.start, Date.UTC(2026, 4, 4, 16, 0, 0));
  // 4 May is a Sunday in 2025, not in 2026: the year is chosen so the weekday agrees.
  assert.equal(parseProviderEventRow(row("PPV| LIVE EVENT 07 [Sun May 4th 4:00PM Canelo vs Mbilli]"), may3).start, Date.UTC(2025, 4, 4, 16, 0, 0));
  // A weekday that matches no nearby year is rejected rather than guessed.
  assert.equal(parseProviderEventRow(row("PPV| LIVE EVENT 07 [Tue Feb 30th 4:00PM Canelo vs Mbilli]"), may3), null);
  assert.equal(parseProviderEventRow(row("PPV| LIVE EVENT 07 [Wed May 4th 4:00PM Canelo vs Mbilli]"), may3), null, "May 4 is never a Wednesday near 2026");
  // Dec -> Jan rollover picks the nearest year.
  const dec = parseProviderEventRow(row("PPV| LIVE EVENT 07 [Jan 2 8pm Canelo vs Mbilli]"), { ...opts, now: Date.UTC(2026, 11, 31, 20) });
  assert.equal(dec.start, Date.UTC(2027, 0, 2, 20, 0, 0));
});

test("configured provider time zone is honoured", () => {
  const parsed = parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-10-31 20:00:00)]"), { ...opts, timezone: "Europe/London" });
  assert.equal(parsed.start, Date.UTC(2026, 9, 31, 20, 0, 0)); // BST ended 2026-10-25
  const summer = zonedTimeMs("Europe/London", 2026, 7, 1, 20, 0);
  assert.equal(summer, Date.UTC(2026, 6, 1, 19, 0, 0));
});

test("rows of one event cluster together, qualifiers stay separate", () => {
  const rows = [
    row("US| PRIME US 007 [Canelo Alvarez vs. Christian Mbilli (2026-10-31 15:58:00)]"),
    row("ES| DAZN 11 [Canelo vs. Mbilli | Riyadh Season (2026-10-31 14:00:00)]", "EU | SPAIN DAZN"),
    row("PPV| LIVE EVENT 03 [(HD) Canelo v Mbilli]", "VIP | PPV-SPORT EVENTS"),
    row("IT| DAZN EVENTO 16 [Canelo vs. Mbilli: Preliminari | Riyadh Season (2026-10-31 14:00:00)]", "EU | ITALY DAZN EVENTO"),
    row("US| DAZN US 016 [Canelo vs. Mbilli: Press Conference | Riyadh Season (2026-10-29 18:00:00)]"),
    row("PPV| UFC [BG] 22 [UFC 334: FIGHT PASS PRELIMS (2026-11-14 16:00:00)]", "VIP | UFC PPV"),
    row("PPV| UFC [BG] 23 [UFC 335: FIGHT PASS PRELIMS (2026-11-21 16:00:00)]", "VIP | UFC PPV"),
  ].map((r) => ({ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  assert.ok(rows.every((x) => x.parsed));
  const clusters = clusterProviderEvents(rows);
  const sizes = clusters.map((c) => c.items.length).sort();
  assert.deepEqual(sizes, [1, 1, 1, 1, 3]);
  const main = clusters.find((c) => c.items.length === 3);
  assert.equal(main.signature.qualifier, "");
});

test("numbered events with different numbers do not merge", () => {
  const a = eventSignature("UFC 334: Main Card");
  const b = eventSignature("UFC 335: Main Card");
  assert.equal(signaturesMatch(a, b), false);
  assert.equal(signaturesMatch(a, eventSignature("UFC 334 Main Card")), true);
});

test("clusters matching a standalone DLHD event are attached instead of duplicated", () => {
  const dlhdRef = { id: "event-dlhd-1", kind: "event", name: "Canelo Alvarez vs Christian Mbilli", start: Date.UTC(2026, 9, 31, 16, 0), end: Date.UTC(2026, 9, 31, 19, 0) };
  const items = [
    row("ES| DAZN 11 [Canelo vs. Mbilli | Riyadh Season (2026-10-31 14:00:00)]", "EU | SPAIN DAZN"),
    row("PPV| LIVE EVENT 03 [(HD) Canelo v Mbilli]", "VIP | PPV-SPORT EVENTS"),
  ].map((r) => ({ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  const result = resolveProviderEvents({ items, dlhdEvents: [dlhdRef], now: NOW });
  assert.equal(result.refs.length, 0);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((x) => x.reference === dlhdRef));
  assert.equal(result.status.attachedToDlhd, 1);
});

test("unmatched cluster becomes a provider event with a start/end window", () => {
  const items = [
    row("PPV| UFC [BG] 21 [CAGE WARRIORS 213 (2026-10-31 14:30:00)]", "VIP | UFC PPV"),
    row("PPV| UFC [BG] 22 [CAGE WARRIORS 213 (2026-10-31 14:30:00)]", "VIP | UFC PPV"),
  ].map((r, i) => ({ source: source(i ? "b" : "a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  const result = resolveProviderEvents({ items, dlhdEvents: [], now: NOW });
  assert.equal(result.refs.length, 1);
  const [ref] = result.refs;
  assert.equal(ref.kind, "event");
  assert.equal(ref.source, "provider");
  assert.equal(ref.name, "CAGE WARRIORS 213");
  assert.equal(ref.start, Date.UTC(2026, 9, 31, 14, 30));
  assert.equal(ref.end, ref.start + 180 * 60_000);
  assert.equal(ref.timeEstimated, false);
  assert.equal(result.rows.length, 2);
});

test("events outside their window are not published", () => {
  const mk = (stamp) => {
    const r = row(`PPV| UFC [BG] 21 [SOME FIGHT (${stamp})]`, "VIP | UFC PPV");
    return [{ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }];
  };
  assert.equal(resolveProviderEvents({ items: mk("2026-10-17 11:30:00"), now: NOW }).status.expired, 1);
  assert.equal(resolveProviderEvents({ items: mk("2026-11-14 16:00:00"), now: NOW }).status.notYetActive, 1);
});

test("an event without any time gets an estimated window from when it was first seen", () => {
  const r = row("PPV| LIVE EVENT 26 [MAIN STAGE Live From Coachella 2026]", "VIP | PPV-SPORT EVENTS");
  const items = [{ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }];
  const first = resolveProviderEvents({ items, now: NOW });
  const [ref] = first.refs;
  assert.equal(ref.start, NOW);
  assert.equal(ref.timeSource, "first-seen");
  assert.equal(ref.timeEstimated, true);

  // Same id, same remembered start on the next refresh...
  const later = resolveProviderEvents({ items, now: NOW + 60 * 60_000, previousRegistry: first.registry });
  assert.equal(later.refs[0].id, ref.id);
  assert.equal(later.refs[0].start, NOW);
  // ...and it expires once the estimated window is over instead of lingering.
  const stale = resolveProviderEvents({ items, now: NOW + 6 * 3600_000, previousRegistry: later.registry });
  assert.equal(stale.refs.length, 0);
  assert.equal(stale.status.expired, 1);
});

test("a sibling row with a time gives the whole cluster its start", () => {
  const items = [
    row("PPV| LIVE EVENT 02 [Canelo v Mbilli]", "VIP | PPV-SPORT EVENTS"),
    row("US| PRIME US 007 [Canelo Alvarez vs. Christian Mbilli (2026-10-31 15:58:00)]"),
  ].map((r) => ({ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  const result = resolveProviderEvents({ items, now: NOW });
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].start, Date.UTC(2026, 9, 31, 15, 58));
  assert.equal(result.refs[0].timeEstimated, false);
});

test("provider events get generated artwork and an EPG programme", () => {
  const items = [row("ES| DAZN 11 [Canelo vs. Mbilli | Riyadh Season (2026-10-31 14:00:00)]", "EU | SPAIN DAZN")]
    .map((r) => ({ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  const { refs } = resolveProviderEvents({ items, now: NOW });
  const ref = refs[0];
  const channel = {
    id: ref.id, key: ref.key, tvgId: ref.tvgId, name: ref.name, group: ref.group, logo: "", aliasNames: [], variants: [],
    referenceKind: "event", dlhdRefId: ref.id,
    event: { start: ref.start, end: ref.end, time: ref.time, category: ref.category, source: "provider", timeEstimated: false },
  };
  const { snapshot } = finalizeSnapshot({ channels: [channel] }, {});
  const [out] = snapshot.channels;
  assert.equal(out.name, "Canelo vs. Mbilli");
  assert.equal(out.event.competition, "Riyadh Season");
  assert.match(out.logo, /\/artwork\/event\/channel\//);
  const guide = syncGuideEvents('<?xml version="1.0"?>\n<tv>\n</tv>\n', snapshot.channels);
  assert.match(guide, /<programme start="20261031140000 \+0000" stop="20261031170000 \+0000"/);
  assert.match(guide, /<title>Canelo vs\. Mbilli<\/title>/);
  const png = eventArtworkPng(out, "channel");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
});

test("only configured PPV / live-event groups produce provider events", () => {
  assert.equal(config.providerEvents.groups, DEFAULT_PROVIDER_EVENT_GROUPS);
  const flo = row("US| FLO SPORTS 12 [wrestling: Pepsi Patriot Open (Mat 5) (2026-10-31 09:00:00)]", "AM | USA FLO");
  assert.equal(parseProviderEventRow(flo, opts), null);
  assert.ok(parseProviderEventRow(flo, { ...opts, groupRe: /flo/i }));
});

test("the number of created provider events is capped, biggest events first", () => {
  const mk = (title, slots) => Array.from({ length: slots }, (_, i) => {
    const r = row(`PPV| LIVE EVENT ${i} [${title} (2026-10-31 14:00:00)]`);
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) };
  });
  const items = [...mk("Small Fight A vs Small Fight B", 1), ...mk("Big Fight A vs Big Fight B", 4)];
  const result = resolveProviderEvents({ items, now: NOW, maxEvents: 1 });
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].name, "Big Fight A vs Big Fight B");
  assert.equal(result.status.capped, 1);
});

test("timestamps with Z or an offset are absolute; impossible dates are rejected", () => {
  const z = parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-10-31T15:58:00Z)]"), { ...opts, timezone: "Europe/London" });
  assert.equal(z.title, "Fight Night");
  assert.equal(z.start, Date.UTC(2026, 9, 31, 15, 58));
  const offset = parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-10-31 20:00:00+02:00)]"), opts);
  assert.equal(offset.start, Date.UTC(2026, 9, 31, 18, 0));
  assert.equal(parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-02-30 20:00:00)]"), opts), null, "an impossible date must not become an event that starts now");
  assert.equal(parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-10-31 20:00:00+25:00)]"), opts), null, "offset hours are validated");
  assert.equal(parseProviderEventRow(row("X| PPV 1 [Fight Night (2026-10-31 20:00:00+0530)]"), opts).start, Date.UTC(2026, 9, 31, 14, 30));
  assert.equal(zonedTimeMs("UTC", 2026, 13, 1, 0, 0), null);
  assert.equal(zonedTimeMs("UTC", 2026, 10, 31, 25, 0), null);
});

test("either the display name or the tvg-name may carry the bracketed title", () => {
  const generic = { name: "PPV| PRIME US 007 [Canelo vs Mbilli (2026-10-31 15:58:00)]", tvgName: "PRIME US 007", group: "VIP | PPV", url: "http://x/1" };
  assert.equal(parseProviderEventRow(generic, opts).title, "Canelo vs Mbilli");
  const reversed = { name: "PRIME US 007", tvgName: "PPV| PRIME US 007 [Canelo vs Mbilli (2026-10-31 15:58:00)]", group: "VIP | PPV", url: "http://x/2" };
  assert.equal(parseProviderEventRow(reversed, opts).title, "Canelo vs Mbilli");
});

test("hostile rows are rejected cheaply", () => {
  const bracketBomb = row(`PPV 1 ${"[ABC]".repeat(100_000)}`);
  assert.equal(parseProviderEventRow(bracketBomb, opts), null);
  assert.equal(parseProviderEventRow({ ...row("PPV 1 [Fight Night]"), group: "AM | USA FLO" }, opts), null);
  const longTitle = parseProviderEventRow(row(`PPV 1 [${"A".repeat(500)} vs ${"B".repeat(500)}]`), opts);
  assert.equal(longTitle, null);
});

test("women's and youth fixtures do not merge with the senior fixture", () => {
  assert.equal(signaturesMatch(eventSignature("Chelsea Women vs Arsenal Women", "women"), eventSignature("Chelsea vs Arsenal", "")), false);
  const items = [row("PPV| LIVE EVENT 1 [Chelsea vs Arsenal (2026-11-01 16:00:00)]"), row("PPV| LIVE EVENT 2 [Chelsea Women vs Arsenal Women (2026-11-01 13:00:00)]"), row("PPV| LIVE EVENT 3 [Chelsea U21 vs Arsenal U21 (2026-11-01 13:00:00)]")]
    .map((r) => ({ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }));
  assert.equal(clusterProviderEvents(items).length, 3);
});

test("event identity does not depend on which provider row arrives first", () => {
  const short = { source: source("a"), row: row("X [Canelo v Mbilli (2026-10-31 15:00:00)]"), parsed: null };
  const long = { source: source("b"), row: row("Y [Canelo Alvarez vs Christian Mbilli (2026-10-31 15:00:00)]"), parsed: null };
  for (const item of [short, long]) item.parsed = parseProviderEventRow(item.row, opts);
  const ab = resolveProviderEvents({ items: [short, long], now: NOW });
  const ba = resolveProviderEvents({ items: [long, short], now: NOW });
  assert.equal(ab.refs[0].id, ba.refs[0].id);
  // Provider A disappears on the next refresh: the same event keeps its id and tvg-id.
  const onlyLong = resolveProviderEvents({ items: [long], previousRegistry: ab.registry, now: NOW + 10 * 60_000 });
  assert.equal(onlyLong.refs[0].id, ab.refs[0].id);
  assert.equal(onlyLong.refs[0].tvgId, ab.refs[0].tvgId);
});

test("an event keeps its first-seen estimate when a different provider row names it", () => {
  const a = row("PPV| LIVE EVENT 26 [Canelo Alvarez vs Christian Mbilli]", "VIP | PPV-SPORT EVENTS");
  const b = row("PPV| LIVE EVENT 27 [Canelo v Mbilli]", "VIP | PPV-SPORT EVENTS");
  const first = resolveProviderEvents({ items: [{ source: source("a"), row: a, parsed: parseProviderEventRow(a, opts) }], now: NOW });
  const later = resolveProviderEvents({ items: [{ source: source("b"), row: b, parsed: parseProviderEventRow(b, opts) }], previousRegistry: first.registry, now: NOW + 3_600_000 });
  assert.equal(later.refs[0].id, first.refs[0].id);
  assert.equal(later.refs[0].start, NOW);
});

test("a clock-only time keeps its first resolved day across midnight instead of reappearing", () => {
  const r = row("PPV| LIVE EVENT 02 [10am Canelo v Mbilli]");
  const at = (now, previousRegistry) => resolveProviderEvents({
    items: [{ source: source("a"), row: r, parsed: parseProviderEventRow(r, { ...opts, now }) }], previousRegistry, now,
  });
  const noon = at(Date.UTC(2026, 9, 31, 13, 0));
  assert.equal(noon.refs[0].start, Date.UTC(2026, 9, 31, 10, 0));
  // Still listed through the evening and past midnight, refreshed regularly.
  let registry = noon.registry;
  let result;
  for (const hour of [18, 23, 29, 34]) { // 18:00, 23:00, 05:00+1d, 10:00+1d
    result = at(Date.UTC(2026, 9, 31, 13) + (hour - 13) * 3_600_000, registry);
    registry = result.registry;
    assert.equal(result.refs.length, 0, `hour ${hour} must stay expired, not become tomorrow's event`);
  }
  assert.equal(result.status.expired + result.status.suppressed, 1);
});

test("a title confirmed absent for a long time is a new occurrence, an unobserved gap is not", () => {
  const r = row("PPV| LIVE EVENT 26 [MAIN STAGE Live From Coachella 2026]", "VIP | PPV-SPORT EVENTS");
  const items = [{ source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) }];
  const first = resolveProviderEvents({ items, now: NOW });
  const stale = resolveProviderEvents({ items, previousRegistry: first.registry, now: NOW + 6 * 3_600_000 });
  assert.equal(stale.refs.length, 0);

  // Nothing ran for two days (service down): the event was never seen to disappear, so it is still the old one.
  const unobserved = resolveProviderEvents({ items, previousRegistry: first.registry, now: NOW + 2 * 24 * 3_600_000 });
  assert.equal(unobserved.refs.length, 0);

  // A successful refresh a day later without the title confirms it was gone...
  const gone = resolveProviderEvents({ items: [], previousRegistry: first.registry, now: NOW + 24 * 3_600_000 });
  // ...so when it returns it is a fresh occurrence with a new estimated start.
  const back = resolveProviderEvents({ items, previousRegistry: gone.registry, now: NOW + 2 * 24 * 3_600_000 });
  assert.equal(back.refs.length, 1);
  assert.equal(back.refs[0].start, NOW + 2 * 24 * 3_600_000);

  // If the source that carried it was down during those refreshes, absence is unconfirmed...
  const failedScan = resolveProviderEvents({ items: [], previousRegistry: first.registry, now: NOW + 24 * 3_600_000, failedSourceIds: ["a"] });
  const afterFailure = resolveProviderEvents({ items, previousRegistry: failedScan.registry, now: NOW + 2 * 24 * 3_600_000, failedSourceIds: ["a"] });
  assert.equal(afterFailure.refs.length, 0);
  // ...but an unrelated source being down confirms nothing either way: source "a" saw it gone.
  const unrelatedScan = resolveProviderEvents({ items: [], previousRegistry: first.registry, now: NOW + 24 * 3_600_000, failedSourceIds: ["b"] });
  const afterUnrelated = resolveProviderEvents({ items, previousRegistry: unrelatedScan.registry, now: NOW + 2 * 24 * 3_600_000, failedSourceIds: ["b"] });
  assert.equal(afterUnrelated.refs.length, 1);
});

test("the registry only remembers events that need it and stays bounded", () => {
  const dated = row("PPV| UFC [BG] 21 [SOME FIGHT (2026-11-14 16:00:00)]", "VIP | UFC PPV");
  const far = resolveProviderEvents({ items: [{ source: source("a"), row: dated, parsed: parseProviderEventRow(dated, opts) }], now: NOW });
  assert.deepEqual(Object.keys(far.registry), ["__meta"], "a not-yet-active dated event needs no memory");
  const items = Array.from({ length: 2500 }, (_, i) => {
    const r = row(`PPV| LIVE EVENT ${i} [Untimed Gala Number${i} Spectacular${i}]`, "VIP | PPV-SPORT EVENTS");
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) };
  });
  const big = resolveProviderEvents({ items, now: NOW });
  assert.ok(Object.keys(big.registry).length <= 1001);
  assert.equal(big.refs.length, 150);
});

test("clustering does a bounded number of comparisons, even when events share common words", () => {
  const parsed = (title, i) => {
    const r = row(`PPV| LIVE EVENT ${i} [${title} (2026-10-31 14:00:00)]`);
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) };
  };
  // Every title shares "Alpha"/"Beta"/"Team"/"Other" - the lexicographically smallest tokens are all common.
  const distinct = Array.from({ length: 4000 }, (_, i) => parsed(`Alpha Team${i} vs Beta Other${i}`, i));
  const stats = { comparisons: 0 };
  assert.equal(clusterProviderEvents(distinct, stats).length, 4000);
  assert.ok(stats.comparisons < 40_000, `${stats.comparisons} comparisons for 4000 unrelated events`);
  const slots = Array.from({ length: 4000 }, (_, i) => parsed("Canelo vs Mbilli", i));
  const slotStats = { comparisons: 0 };
  assert.equal(clusterProviderEvents(slots, slotStats).length, 1);
  assert.ok(slotStats.comparisons < 40_000, `${slotStats.comparisons} comparisons for 4000 identical slots`);
});

test("rows already mapped to a DLHD event (direct or EPG-assisted) are not provider-only events", () => {
  const r = row("PPV| LIVE EVENT 03 [Canelo vs Mbilli (2026-10-31 15:00:00)]");
  const other = row("PPV| LIVE EVENT 04 [Cage Warriors 213 (2026-10-31 14:30:00)]");
  const items = [r, other].map((x) => ({ source: source("a"), row: x, parsed: parseProviderEventRow(x, opts) }));
  const assisted = [{ source: source("a"), row: r, reference: { kind: "event", id: "event-dlhd-1" } }];
  const remaining = excludeClaimedRows(items, assisted);
  assert.deepEqual(remaining.map((x) => x.row), [other]);
  // A static-channel mapping does not claim the row.
  assert.equal(excludeClaimedRows(items, [{ source: source("a"), row: r, reference: { kind: "channel", id: "c" } }]).length, 2);
});

test("a published provider event survives a source outage until its window ends", () => {
  const channel = { referenceKind: "event", event: { source: "provider", end: NOW + 3_600_000 } };
  assert.equal(providerEventRetainable(channel, { now: NOW, tailMinutes: 60 }), true);
  assert.equal(providerEventRetainable(channel, { now: NOW + 3_600_000 + 59 * 60_000, tailMinutes: 60 }), true);
  assert.equal(providerEventRetainable(channel, { now: NOW + 3_600_000 + 61 * 60_000, tailMinutes: 60 }), false);
  assert.equal(providerEventRetainable({ referenceKind: "event", event: { end: NOW + 1 } }, { now: NOW }), false, "DLHD events keep the existing rule");
  assert.equal(providerEventRetainable({ referenceKind: "channel", event: null }, { now: NOW }), false);
});

test("with nothing to find the resolver produces no rows, refs or registry changes", () => {
  const empty = resolveProviderEvents({ items: [], now: NOW, previousRegistry: {} });
  assert.deepEqual({ rows: empty.rows, refs: empty.refs, registry: Object.keys(empty.registry) }, { rows: [], refs: [], registry: ["__meta"] });
});

const at = (title, stamp, src = "a", group = "VIP | PPV-SPORT EVENTS") => {
  const r = row(`PPV| LIVE EVENT ${src}${title.length} [${title}${stamp ? ` (${stamp})` : ""}]`, group);
  return { source: source(src), row: r, parsed: parseProviderEventRow(r, opts) };
};

test("the same title at two different times the same day gets two distinct events and ids", () => {
  const now = Date.UTC(2026, 9, 31, 15, 0);
  const result = resolveProviderEvents({
    items: [at("Cricket Live", "2026-10-31 08:00:00", "a"), at("Cricket Live", "2026-10-31 18:00:00", "b")],
    now,
  });
  assert.equal(result.refs.length, 2);
  assert.equal(new Set(result.refs.map((x) => x.id)).size, 2);
  assert.equal(new Set(result.refs.map((x) => x.tvgId)).size, 2);
  assert.ok(result.refs.every((x) => x.tvgId.startsWith("justone.pevent.")));
  assert.equal(Object.keys(result.registry).filter((k) => k !== "__meta").length, 2);
});

test("a remembered identity goes to the closest occurrence, each identity at most once", () => {
  const first = resolveProviderEvents({
    items: [at("Cricket Live", "2026-10-31 22:00:00", "a"), at("Cricket Live", "2026-11-01 08:00:00", "b")],
    now: Date.UTC(2026, 10, 1, 4, 30), // both occurrences are inside their windows
  });
  assert.equal(first.refs.length, 2);
  const [early, late] = [...first.refs].sort((x, y) => x.start - y.start);
  // The 06:00 row is 2h from the 08:00 occurrence and 8h from the 22:00 one: both are
  // "compatible", but the closer one must win regardless of registry order.
  const again = resolveProviderEvents({
    items: [at("Cricket Live", "2026-11-01 06:00:00", "c")],
    previousRegistry: first.registry,
    now: Date.UTC(2026, 10, 1, 5, 0),
  });
  assert.equal(again.refs[0].id, late.id);
  assert.notEqual(again.refs[0].id, early.id);
  // Two clusters never share one remembered identity.
  const two = resolveProviderEvents({
    items: [at("Cricket Live", "2026-11-01 07:00:00", "a"), at("Cricket Live", "2026-11-01 17:00:00", "b")],
    previousRegistry: first.registry,
    now: Date.UTC(2026, 10, 1, 14, 0),
  });
  assert.equal(two.refs.length, 2);
  assert.equal(new Set(two.refs.map((x) => x.id)).size, 2);
});

test("a clock-only event does not inherit another clock time's identity", () => {
  const morning = resolveProviderEvents({ items: [at("10am Cricket Live", "", "a")], now: Date.UTC(2026, 9, 31, 13, 0) });
  const later = resolveProviderEvents({
    items: [at("11pm Cricket Live", "", "b")],
    previousRegistry: morning.registry,
    now: Date.UTC(2026, 9, 31, 22, 0),
  });
  assert.equal(later.refs.length, 1);
  assert.notEqual(later.refs[0].id, morning.refs[0].id);
  assert.equal(later.refs[0].start, Date.UTC(2026, 9, 31, 23, 0));
});

test("a full registry fails closed: estimated events that cannot be remembered are not published", () => {
  const now = Date.UTC(2026, 9, 31, 13, 0);
  const make = (n, at_) => Array.from({ length: n }, (_, i) => {
    const r = row(`PPV| LIVE EVENT ${i} [EventUnique${i} Spectacular${i}]`, "VIP | PPV-SPORT EVENTS");
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, { ...opts, now: at_ }) };
  });
  const first = resolveProviderEvents({ items: make(2010, now), now });
  assert.equal(first.status.unremembered, 1010, "1000 active slots fit; the rest are not published");
  const later = Date.UTC(2026, 9, 31, 19, 0);
  const second = resolveProviderEvents({ items: make(2010, later), previousRegistry: first.registry, now: later });
  assert.equal(second.refs.length, 0, "nothing that expired is re-created because it was evicted");
  assert.equal(second.status.expired + second.status.unremembered, 2010);
});

test("the cluster result does not depend on provider order, and abbreviations do not chain different names", () => {
  const rows = ["Canelo Alvarez vs Christian Mbilli", "Canelo vs Mbilli", "Canelo Junior vs Mbilli"].map((t, i) => at(t, "2026-10-31 15:00:00", `s${i}`));
  const shapes = new Set();
  for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0], [2, 0, 1], [1, 2, 0], [0, 2, 1]]) {
    const clusters = clusterProviderEvents(order.map((i) => rows[i]));
    shapes.add(clusters.map((c) => c.items.map((x) => x.parsed.title).sort().join("+")).sort().join(" | "));
  }
  assert.equal(shapes.size, 1, [...shapes].join("\n"));
  const [shape] = shapes;
  assert.ok(!shape.includes("Canelo Alvarez vs Christian Mbilli+Canelo Junior"), "the two specific names must not merge");
});

test("DST: a repeated hour takes the first occurrence, a skipped hour shifts forward", () => {
  assert.equal(zonedTimeMs("Europe/London", 2026, 3, 29, 1, 30), Date.UTC(2026, 2, 29, 1, 30), "01:30 does not exist -> 02:30 BST");
  assert.equal(zonedTimeMs("Europe/London", 2026, 10, 25, 1, 30), Date.UTC(2026, 9, 25, 0, 30), "01:30 happens twice -> the BST one");
  assert.equal(zonedTimeMs("America/New_York", 2026, 3, 8, 2, 30), Date.UTC(2026, 2, 8, 7, 30), "02:30 does not exist -> 03:30 EDT");
  assert.equal(zonedTimeMs("America/New_York", 2026, 11, 1, 1, 30), Date.UTC(2026, 10, 1, 5, 30), "01:30 happens twice -> the EDT one");
  assert.equal(zonedTimeMs("Europe/London", 2026, 7, 1, 20, 0), Date.UTC(2026, 6, 1, 19, 0));
});

test("an authoritative timestamp does not strip date-like words from the title", () => {
  const parsed = parseProviderEventRow(row("PPV 01 [The Dec 25 5pm Showdown (2026-10-31 15:00:00)]"), opts);
  assert.equal(parsed.title, "The Dec 25 5pm Showdown");
  assert.equal(parsed.start, Date.UTC(2026, 9, 31, 15, 0));
});

test("provider events from a preserved guide are removed once they are no longer published", () => {
  const guide = [
    '<?xml version="1.0"?>', "<tv>",
    '  <channel id="justone.pevent.old-event-aaaaaaaa"><display-name>Old</display-name></channel>',
    '  <channel id="justone.pevent.live-event-bbbbbbbb"><display-name>Live</display-name></channel>',
    '  <channel id="justone.event.dlhd-cccccccc"><display-name>DLHD event</display-name></channel>',
    '  <channel id="justone.bbc"><display-name>BBC One</display-name></channel>',
    '  <programme start="20261031100000 +0000" stop="20261031130000 +0000" channel="justone.pevent.old-event-aaaaaaaa"><title>Old</title></programme>',
    '  <programme start="20261031100000 +0000" stop="20261031130000 +0000" channel="justone.pevent.live-event-bbbbbbbb"><title>Live</title></programme>',
    '  <programme start="20261031100000 +0000" stop="20261031130000 +0000" channel="justone.bbc"><title>News</title></programme>',
    "</tv>",
  ].join("\n");
  const live = [{ referenceKind: "event", tvgId: "justone.pevent.live-event-bbbbbbbb" }];
  const cleaned = removeStaleProviderEvents(guide, live);
  assert.ok(!cleaned.includes("old-event-aaaaaaaa"));
  assert.ok(cleaned.includes("live-event-bbbbbbbb"));
  assert.ok(cleaned.includes("justone.event.dlhd-cccccccc"), "DLHD event entries are untouched");
  assert.ok(cleaned.includes('channel="justone.bbc"'));
  // Feature switched off: no provider events are published, none may survive.
  assert.ok(!removeStaleProviderEvents(guide, []).includes("justone.pevent."));
  assert.ok(!syncGuideEvents(guide, []).includes("justone.pevent."));
});

test("a retained variant only follows the same occurrence of an event", () => {
  const old = { event: { start: Date.UTC(2026, 9, 31, 10, 0) } };
  assert.equal(sameProviderOccurrence(old, { event: { start: Date.UTC(2026, 9, 31, 12, 0) } }), true);
  assert.equal(sameProviderOccurrence(old, { event: { start: Date.UTC(2026, 10, 1, 10, 0) } }), false);
});

const untimed = (n, now, prefix = "Gala", src = "a") => Array.from({ length: n }, (_, i) => {
  const r = row(`PPV| LIVE EVENT ${src}${i} [${prefix} Number${i} Spectacular${i}]`, "VIP | PPV-SPORT EVENTS");
  return { source: source(src), row: r, parsed: parseProviderEventRow(r, { ...opts, now }) };
});

test("expired events never starve a new event, and are not re-created either", () => {
  const first = Date.UTC(2026, 9, 31, 13, 0);
  const later = Date.UTC(2026, 9, 31, 19, 0);
  const wide = { maxEvents: 5000 };
  const a = resolveProviderEvents({ items: untimed(900, first), now: first, ...wide });
  assert.equal(a.refs.length, 900);
  const fresh = at("New Gala Zzzz Special", "", "a");
  const b = resolveProviderEvents({
    items: [...untimed(900, later), { ...fresh, parsed: parseProviderEventRow(fresh.row, { ...opts, now: later }) }],
    previousRegistry: a.registry, now: later, ...wide,
  });
  assert.deepEqual(b.refs.map((x) => x.name), ["New Gala Zzzz Special"], "the new event is published; the 900 expired ones are not");
  assert.equal(b.status.unremembered, 0);
  // Even filling the active registry with expired titles cannot hide a new one.
  const full = resolveProviderEvents({ items: untimed(1000, first), now: first, ...wide });
  assert.equal(full.refs.length, 1000);
  const next = resolveProviderEvents({
    items: [...untimed(1000, later), { ...fresh, parsed: parseProviderEventRow(fresh.row, { ...opts, now: later }) }],
    previousRegistry: full.registry, now: later, ...wide,
  });
  assert.deepEqual(next.refs.map((x) => x.name), ["New Gala Zzzz Special"]);
});

test("a constant opponent does not make clustering quadratic", () => {
  const parsed = (title, i, hour = 14) => {
    const r = row(`PPV| LIVE EVENT ${i} [${title} (2026-10-31 ${hour}:00:00)]`);
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) };
  };
  for (const make of [(i) => `Alpha Team${i} vs Beta`, (i) => `Gamma vs Delta Club${i}`, (i) => `Beta vs Alpha Team${i}`]) {
    const stats = { comparisons: 0 };
    const clusters = clusterProviderEvents(Array.from({ length: 3000 }, (_, i) => parsed(make(i), i)), stats);
    assert.equal(clusters.length, 3000);
    assert.ok(stats.comparisons < 30_000, `${stats.comparisons} comparisons for ${make(0)}`);
  }
  // Correctness is unchanged: variants of one fixture still merge when the other side is shared.
  const merged = clusterProviderEvents([parsed("Alpha Team1 vs Beta", 1), parsed("Alpha vs Beta", 2), parsed("Alpha Team2 vs Beta", 3)]);
  assert.deepEqual(merged.map((c) => c.items.length).sort(), [1, 2]);
});

test("an outage of an unrelated source does not stop a returning event being recognised as new", () => {
  const day = (n) => Date.UTC(2026, 9, 31 + n, 13, 0);
  const concert = (now) => [{ ...at("Concert Festival Grand Show", "", "a"), parsed: parseProviderEventRow(at("Concert Festival Grand Show", "", "a").row, { ...opts, now }) }];
  const d1 = resolveProviderEvents({ items: concert(day(0)), now: day(0), failedSourceIds: [] });
  assert.equal(d1.refs.length, 1);
  const d2 = resolveProviderEvents({ items: [], previousRegistry: d1.registry, now: day(1), failedSourceIds: ["b"] });
  const unrelated = resolveProviderEvents({ items: concert(day(2)), previousRegistry: d2.registry, now: day(2), failedSourceIds: ["b"] });
  assert.equal(unrelated.refs.length, 1, "source a saw it gone on day 2; source b being down is irrelevant");
  assert.equal(unrelated.refs[0].start, day(2));
  const d2a = resolveProviderEvents({ items: [], previousRegistry: d1.registry, now: day(1), failedSourceIds: ["a"] });
  const related = resolveProviderEvents({ items: concert(day(2)), previousRegistry: d2a.registry, now: day(2), failedSourceIds: ["a"] });
  assert.equal(related.refs.length, 0, "its own source was down, so its disappearance was never confirmed");
});

test("a cluster's whole start-time span stays within tolerance, whatever order rows arrive in", () => {
  const rows = [15, 8, 22].map((hour, i) => at("Cricket Live", `2026-10-31 ${String(hour).padStart(2, "0")}:00:00`, `s${i}`));
  const shapes = new Set();
  for (const order of [[0, 1, 2], [1, 0, 2], [2, 0, 1], [0, 2, 1], [1, 2, 0], [2, 1, 0]]) {
    const clusters = clusterProviderEvents(order.map((i) => rows[i]));
    for (const c of clusters) assert.ok(c.maxStart - c.minStart <= 8 * 3_600_000, "span too wide");
    shapes.add(clusters.map((c) => c.starts.map((t) => new Date(t).getUTCHours()).sort((a, b) => a - b).join(",")).sort().join(" | "));
  }
  assert.equal(shapes.size, 1);
  assert.equal(clusterProviderEvents(rows).length, 2);
});

test("continuity depends on recorded confirmed absence, not on run metadata", () => {
  const day = Date.UTC(2026, 9, 29, 13, 0);
  const seeded = resolveProviderEvents({ items: [at("Concert Festival Grand Show", "", "a")], now: day });
  const [id] = Object.keys(seeded.registry).filter((k) => k !== "__meta");
  const now = day + 48 * 3_600_000;
  const run = (registry) => {
    const item = at("Concert Festival Grand Show", "", "a");
    return resolveProviderEvents({ items: [{ ...item, parsed: parseProviderEventRow(item.row, { ...opts, now }) }], previousRegistry: registry, now });
  };
  // No successful scan ever saw it gone, whatever the metadata says (missing, garbage, in the future).
  for (const meta of [undefined, { lastRun: "soon" }, { lastRun: -5 }, { lastRun: now + 10 * 24 * 3_600_000 }, { tombs: "nope" }]) {
    const registry = { [id]: seeded.registry[id] };
    if (meta) registry.__meta = meta;
    assert.equal(run(registry).refs.length, 0, `meta ${JSON.stringify(meta)}`);
  }
  // Once a scan with all its sources healthy missed it, it is gone and the title is a new occurrence.
  const absent = resolveProviderEvents({ items: [], previousRegistry: seeded.registry, now: day + 24 * 3_600_000 });
  assert.ok(Number.isFinite(absent.registry[id].goneAt));
  const back = run(absent.registry);
  assert.equal(back.refs.length, 1);
  assert.equal(back.refs[0].start, now);
});

test("a weekday and a clock are one expression in either order", () => {
  const fri = { ...opts, now: Date.UTC(2026, 9, 30, 12, 0) }; // Friday 30 Oct 2026
  const sat7pm = Date.UTC(2026, 9, 31, 19, 0);
  for (const raw of ["Canelo vs Mbilli Sat 7 pm", "Sat 7 pm Canelo vs Mbilli", "Canelo vs Mbilli Saturday 19:00", "7pm Sat Canelo vs Mbilli", "Saturday, 7:00pm Canelo vs Mbilli"]) {
    const parsed = parseProviderEventRow(row(`PPV 01 [${raw}]`), fri);
    assert.equal(parsed.title, "Canelo vs Mbilli", raw);
    assert.equal(parsed.start, sat7pm, raw);
    assert.equal(parsed.timeSource, "title-weekday", raw);
  }
  // A bare number after a weekday is not a clock.
  assert.equal(parseProviderEventRow(row("PPV 01 [Sun 5 Nations Highlights Show]"), fri).start, null);
});

test("stale guide cleanup only looks at an element's own id / channel attribute", () => {
  const guide = [
    "<tv>",
    '  <channel id="justone.bbc" data-id="justone.pevent.fake"><display-name>BBC</display-name></channel>',
    '  <programme channel="justone.bbc" backup-channel="justone.pevent.fake" start="20261031100000 +0000" stop="20261031110000 +0000"><title>News</title></programme>',
    '  <channel id="justone.pevent.gone-1"><display-name>Gone</display-name></channel>',
    "  <programme start=\"20261031100000 +0000\" stop=\"20261031110000 +0000\" channel='justone.pevent.gone-1'><title>Gone</title></programme>",
    "</tv>",
  ].join("\n");
  const cleaned = removeStaleProviderEvents(guide, []);
  assert.ok(cleaned.includes('id="justone.bbc"') && cleaned.includes('<title>News</title>'), "unrelated BBC entries survive");
  assert.ok(!cleaned.includes("gone-1") && !cleaned.includes("<title>Gone</title>"));
  // One pass over the document, however many stale ids there are.
  const many = Array.from({ length: 300 }, (_, i) => `<channel id="justone.pevent.x-${i}"><display-name>x</display-name></channel><programme channel="justone.pevent.x-${i}" start="a" stop="b"><title>x</title></programme>`).join("\n");
  const started = process.hrtime.bigint();
  assert.equal(removeStaleProviderEvents(`<tv>\n${many}\n</tv>`, []).includes("justone.pevent"), false);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2000);
});

test("a tombstone suppresses only the event it was written for, not one that shares a generic alias", () => {
  const at12 = Date.UTC(2026, 9, 31, 12, 0), at17 = Date.UTC(2026, 9, 31, 17, 0), at18 = Date.UTC(2026, 9, 31, 18, 0);
  const pair = (now, titles) => titles.map(([title, src]) => ({ ...at(title, "", src), parsed: parseProviderEventRow(at(title, "", src).row, { ...opts, now }) }));
  const first = resolveProviderEvents({ items: pair(at12, [["Comedy Night Show", "a"], ["Night Show", "b"]]), now: at12 });
  assert.equal(first.refs.length, 1);
  const expired = resolveProviderEvents({ items: pair(at17, [["Comedy Night Show", "a"], ["Night Show", "b"]]), previousRegistry: first.registry, now: at17 });
  assert.equal(expired.refs.length, 0);
  const next = resolveProviderEvents({ items: pair(at18, [["Music Night Show", "a"], ["Night Show", "b"]]), previousRegistry: expired.registry, now: at18 });
  assert.deepEqual(next.refs.map((r) => r.name), ["Music Night Show"], "the different event is published");
  // The old event stays suppressed when only its generic alias is left, and the suppressed cluster adds no tombstones.
  const tombsBefore = Object.keys(expired.registry.__meta.tombs).length;
  const alias = resolveProviderEvents({ items: pair(at18, [["Night Show", "b"]]), previousRegistry: expired.registry, now: at18 });
  assert.equal(alias.refs.length, 0);
  assert.equal(alias.status.suppressed, 1);
  assert.equal(Object.keys(alias.registry.__meta.tombs).length, tombsBefore);
});

test("an event held back only because the registry was full is admitted later, keeping its first-seen time", () => {
  const wide = { maxEvents: 5000 };
  const t10 = Date.UTC(2026, 9, 31, 10, 0), t11 = Date.UTC(2026, 9, 31, 11, 0), t1410 = Date.UTC(2026, 9, 31, 14, 10);
  const fresh = (now) => { const r = row("PPV| LIVE EVENT 9999 [Fresh New Gala Special]", "VIP | PPV-SPORT EVENTS"); return { source: source("a"), row: r, parsed: parseProviderEventRow(r, { ...opts, now }) }; };
  const run1 = resolveProviderEvents({ items: untimed(1000, t10), now: t10, ...wide });
  const run2 = resolveProviderEvents({ items: [...untimed(1000, t11), fresh(t11)], previousRegistry: run1.registry, now: t11, ...wide });
  assert.equal(run2.status.unremembered, 1);
  assert.equal(run2.refs.length, 1000);
  const run3 = resolveProviderEvents({ items: [...untimed(1000, t1410), fresh(t1410)], previousRegistry: run2.registry, now: t1410, ...wide });
  assert.deepEqual(run3.refs.map((r) => r.name), ["Fresh New Gala Special"]);
  assert.equal(run3.refs[0].start, t11, "estimated start is when it was first seen, not when it was admitted");
});

test("tombstone overflow fails closed instead of resurrecting an evicted expired event", () => {
  const t12 = Date.UTC(2026, 9, 31, 12, 0), t17 = Date.UTC(2026, 9, 31, 17, 0), t1701 = Date.UTC(2026, 9, 31, 17, 1);
  const wide = { maxEvents: 50_000 };
  const run1 = resolveProviderEvents({ items: untimed(20_001, t12), now: t12, ...wide });
  assert.equal(run1.refs.length, 1000);
  const run2 = resolveProviderEvents({ items: untimed(20_001, t17), previousRegistry: run1.registry, now: t17, ...wide });
  assert.equal(run2.refs.length, 0);
  assert.ok(Number.isFinite(run2.registry.__meta.overflowAt), "the overflow is recorded");
  const run3 = resolveProviderEvents({ items: untimed(20_001, t1701), previousRegistry: run2.registry, now: t1701, ...wide });
  assert.equal(run3.refs.length, 0, "nothing continuously listed comes back");
  assert.ok(run3.status.overflowSuppressed >= 1);
});

test("a failed scan followed by recovery does not start a new occurrence", () => {
  const day = (n) => Date.UTC(2026, 9, 31 + n, 13, 0);
  const festival = (now) => [{ ...at("Festival Grand Show", "", "a"), parsed: parseProviderEventRow(at("Festival Grand Show", "", "a").row, { ...opts, now }) }];
  const d1 = resolveProviderEvents({ items: festival(day(0)), now: day(0) });
  const d2 = resolveProviderEvents({ items: [], previousRegistry: d1.registry, now: day(1), failedSourceIds: ["a"] });
  const d3 = resolveProviderEvents({ items: festival(day(2)), previousRegistry: d2.registry, now: day(2), failedSourceIds: [] });
  assert.equal(d3.refs.length, 0, "no successful scan ever saw it gone");
});

test("every contributing source is tracked, however many there are", () => {
  const day = (n) => Date.UTC(2026, 9, 31 + n, 13, 0);
  const nine = (now) => Array.from({ length: 9 }, (_, i) => ({ ...at("Festival Grand Show", "", `s${i}`), parsed: parseProviderEventRow(at("Festival Grand Show", "", `s${i}`).row, { ...opts, now }) }));
  const d1 = resolveProviderEvents({ items: nine(day(0)), now: day(0) });
  assert.equal(Object.values(d1.registry).find((e) => e.sources).sources.length, 9);
  const d2 = resolveProviderEvents({ items: [], previousRegistry: d1.registry, now: day(1), failedSourceIds: ["s8"] });
  const d3 = resolveProviderEvents({ items: nine(day(2)).slice(0, 1), previousRegistry: d2.registry, now: day(2), failedSourceIds: ["s8"] });
  assert.equal(d3.refs.length, 0, "s8 carried the event and was down, so its absence was never confirmed");
  // Beyond the tracking limit the list is unknown (null) and every failure is treated as relevant.
  const many = (now) => Array.from({ length: 70 }, (_, i) => ({ ...at("Festival Grand Show", "", `m${i}`), parsed: parseProviderEventRow(at("Festival Grand Show", "", `m${i}`).row, { ...opts, now }) }));
  const m1 = resolveProviderEvents({ items: many(day(0)), now: day(0) });
  assert.equal(Object.values(m1.registry).find((e) => "sources" in e).sources, null);
  const m2 = resolveProviderEvents({ items: [], previousRegistry: m1.registry, now: day(1), failedSourceIds: ["unrelated"] });
  assert.equal(Object.values(m2.registry).find((e) => "sources" in e).goneAt, undefined);
});

test("identical titles on many different dates are separated without scanning each other", () => {
  const parsed = (i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const r = row(`PPV| LIVE EVENT ${i} [Canelo vs Mbilli (${date} 14:00:00)]`);
    return { source: source("a"), row: r, parsed: parseProviderEventRow(r, opts) };
  };
  const stats = { comparisons: 0, candidates: 0 };
  const clusters = clusterProviderEvents(Array.from({ length: 4000 }, (_, i) => parsed(i)), stats);
  assert.equal(clusters.length, 4000);
  assert.ok(stats.candidates < 40_000, `${stats.candidates} candidates examined for 4000 separate days`);
  // Untimed rows still reach the timed clusters of the same title.
  const untimedRow = { source: source("a"), row: row("PPV| LIVE EVENT 9 [Canelo vs Mbilli]"), parsed: null };
  untimedRow.parsed = parseProviderEventRow(untimedRow.row, opts);
  assert.equal(clusterProviderEvents([parsed(1), untimedRow]).length, 1);
});

test("stale guide cleanup understands XML: comments, CDATA, self-closing tags and quoted '>'", () => {
  const stale = "justone.pevent.fake";
  const bbc = '<channel id="bbc"><display-name>BBC One</display-name></channel>';
  const gone = (guide, channels = []) => removeStaleProviderEvents(guide, channels);
  // A commented-out channel must not swallow the real one that follows.
  const commented = gone(`<tv>\n  <!-- <channel id="${stale}"> commented out -->\n  ${bbc}\n</tv>`);
  assert.ok(commented.includes(bbc) && commented.endsWith("</tv>"));
  // A self-closing stale channel is removed on its own.
  const selfClosing = gone(`<tv><channel id="${stale}" />${bbc}</tv>`);
  assert.ok(selfClosing.includes(bbc) && !selfClosing.includes(stale));
  // A quoted ">" inside another attribute does not hide the id.
  const quoted = gone(`<tv><channel note="foo > bar" id="${stale}"><display-name>Old</display-name></channel>${bbc}</tv>`);
  assert.ok(!quoted.includes(stale) && quoted.includes(bbc));
  // CDATA containing a closing tag does not end the element early.
  const cdata = gone(`<tv><programme channel="${stale}" start="a" stop="b"><title><![CDATA[ </programme> ]]></title></programme><programme channel="bbc" start="a" stop="b"><title>News</title></programme></tv>`);
  assert.ok(!cdata.includes(stale) && !cdata.includes("CDATA") && cdata.includes('<title>News</title>') && cdata.endsWith("</tv>"));
  // Currently published ids and foreign ids are kept.
  const live = gone(`<tv><channel id="${stale}"></channel></tv>`, [{ referenceKind: "event", tvgId: stale }]);
  assert.ok(live.includes(stale));
  // Malformed input with many unclosed opening tags still terminates (each element name is
  // searched for a closing tag once, not once per opening tag) and keeps what it cannot parse.
  const malformed = `<tv>${'<channel id="x">'.repeat(20_000)}</tv>`;
  assert.equal(gone(malformed.replace("<tv>", `<tv><channel id="${stale}"/>`)).includes(stale), false);
});

test("an invalid weekday-clock time makes the row ineligible", () => {
  const fri = { ...opts, now: Date.UTC(2026, 9, 30, 12, 0) };
  for (const raw of ["Saturday 25:00 Canelo vs Mbilli", "Canelo vs Mbilli Sunday 99pm", "Sat 7:75pm Canelo vs Mbilli"]) {
    assert.equal(parseProviderEventRow(row(`PPV 01 [${raw}]`), fri), null, raw);
  }
});
