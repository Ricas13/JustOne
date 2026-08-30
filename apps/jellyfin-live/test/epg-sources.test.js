import test from "node:test";
import assert from "node:assert/strict";
import { parseEpgShareIndex, selectEpgShareUrls } from "../src/epg-sources.js";

test("EPGShare index parser finds XMLTV gzip packs", () => {
  const html = `
    <a href="epg_ripper_UK1.xml.gz">UK</a>
    <a href="epg_ripper_US1.xml.gz">US</a>
    <a href="epg_ripper_US2.xml.gz">US2</a>
    <a href="epg_ripper_ALL_SOURCES1.xml.gz">all</a>
  `;
  const rows = parseEpgShareIndex(html);
  assert.deepEqual(rows.map((x) => x.pack), ["UK1", "US1", "US2", "ALL_SOURCES1"]);
});

test("fallback selects country packs by lineup weight and maps GB to UK", () => {
  const lineup = [
    ...Array.from({ length: 100 }, (_, i) => ({ kind: "static", country: "US", id: `us${i}` })),
    ...Array.from({ length: 60 }, (_, i) => ({ kind: "static", country: "GB", id: `gb${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "static", country: "PT", id: `pt${i}` })),
  ];
  const files = [
    { file: "epg_ripper_UK1.xml.gz", pack: "UK1" },
    { file: "epg_ripper_US1.xml.gz", pack: "US1" },
    { file: "epg_ripper_US2.xml.gz", pack: "US2" },
    { file: "epg_ripper_PT1.xml.gz", pack: "PT1" },
    { file: "epg_ripper_ALL_SOURCES1.xml.gz", pack: "ALL_SOURCES1" },
  ];
  const urls = selectEpgShareUrls(lineup, files, 4);
  assert.equal(urls.length, 4);
  assert.match(urls[0], /US1\.xml\.gz$/);
  assert.match(urls[1], /UK1\.xml\.gz$/);
  assert.match(urls[2], /PT1\.xml\.gz$/);
  assert.match(urls[3], /US2\.xml\.gz$/);
  assert.equal(urls.some((x) => /ALL_SOURCES/.test(x)), false);
});
