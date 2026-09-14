import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseM3u, parseM3uStream } from "../src/m3u.js";

const sample = `#EXTM3U\n#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="https://logo/1.png" group-title="UK",UK: BBC One HD\nhttp://provider/live/1\n`;

test("parseM3u preserves source metadata", () => {
  const [row] = parseM3u(sample);
  assert.equal(row.tvgId, "bbc1.uk");
  assert.equal(row.tvgName, "BBC One");
  assert.equal(row.group, "UK");
  assert.equal(row.url, "http://provider/live/1");
});

test("parseM3uStream handles arbitrary network chunk boundaries", async () => {
  const body = `${sample}#EXTINF:-1 tvg-name="RTP 1" group-title="Portugal",PT: RTP 1 FHD\nhttps://provider/live/2\n`;
  const chunks = [];
  for (let i = 0; i < body.length; i += 17) chunks.push(Buffer.from(body.slice(i, i + 17)));
  const rows = [];
  const stats = await parseM3uStream(Readable.from(chunks), { onRow: (row) => rows.push(row) });
  assert.equal(stats.rows, 2);
  assert.equal(rows[0].tvgName, "BBC One");
  assert.equal(rows[1].tvgName, "RTP 1");
  assert.equal(rows[1].url, "https://provider/live/2");
});

test("parseM3uStream can scan a large generated playlist incrementally", async () => {
  const count = 20000;
  function* chunks() {
    yield Buffer.from("#EXTM3U\n");
    for (let i = 0; i < count; i++) {
      yield Buffer.from(`#EXTINF:-1 tvg-name="Channel ${i}" group-title="Other",Channel ${i}\nhttps://provider/live/${i}\n`);
    }
  }
  let seen = 0;
  const stats = await parseM3uStream(Readable.from(chunks()), { onRow: () => { seen += 1; } });
  assert.equal(seen, count);
  assert.equal(stats.rows, count);
  assert.ok(stats.bytes > 1_000_000);
});
