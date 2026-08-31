import test from "node:test";
import assert from "node:assert/strict";
import { filterJellyfinRows, isProgrammeFeedStyleChannel } from "../src/filter.js";

test("show-specific temporary feeds are removed while real networks stay", () => {
  const rows = [
    { name: "Big Brother S28 CAM 1", group: "24/7" },
    { name: "Big Brother 28 Live Feeds Quadview - BB Cam Live", group: "Live" },
    { name: "Saturday Night Live (SNL USA) - NBC", group: "USA" },
    { name: "Breaking Bad S03E07", group: "TV Shows" },
    { name: "AXN", group: "TV Shows" },
    { name: "Fox Movies", group: "Movies" },
    { name: "NBC", group: "USA" },
  ];

  assert.equal(isProgrammeFeedStyleChannel(rows[0]), true);
  assert.equal(isProgrammeFeedStyleChannel(rows[1]), true);
  assert.equal(isProgrammeFeedStyleChannel(rows[2]), true);
  assert.deepEqual(
    filterJellyfinRows(rows).map((row) => row.name),
    ["AXN", "Fox Movies", "NBC"],
  );
});
