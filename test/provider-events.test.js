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
  assert.equal(result.status.expired, 1);
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

  // If a source was down during those refreshes, absence is unconfirmed.
  const failedScan = resolveProviderEvents({ items: [], previousRegistry: first.registry, now: NOW + 24 * 3_600_000, sourcesIncomplete: true });
  const afterFailure = resolveProviderEvents({ items, previousRegistry: failedScan.registry, now: NOW + 2 * 24 * 3_600_000, sourcesIncomplete: true });
  assert.equal(afterFailure.refs.length, 0);
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
  assert.ok(Object.keys(big.registry).length <= 2000);
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
  assert.equal(first.status.unremembered, 11, "2000 slots (one is the meta entry) fit; the rest are dropped");
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
