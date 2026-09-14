import test from "node:test";
import assert from "node:assert/strict";
import { parseM3u } from "../src/m3u.js";

const sample = `#EXTM3U\n#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="https://logo/1.png" group-title="UK",UK: BBC One HD\nhttp://provider/live/1\n`;

test("parseM3u preserves source metadata", () => {
  const [row] = parseM3u(sample);
  assert.equal(row.tvgId, "bbc1.uk");
  assert.equal(row.tvgName, "BBC One");
  assert.equal(row.group, "UK");
  assert.equal(row.url, "http://provider/live/1");
});
