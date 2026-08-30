import test from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, movieFolder, seriesFolder, episodeFile } from "../src/naming.js";

test("movie folder and STRM filename use the Jellyfin TMDb id format", () => {
  const out = movieFolder("Blade Runner: 2049", 2017, 335984);
  assert.equal(out.folder, "Blade Runner - 2049 (2017) [tmdbid-335984]");
  assert.equal(out.file, "Blade Runner - 2049 (2017) [tmdbid-335984].strm");
});

test("movie title does not duplicate an existing year suffix", () => {
  const out = movieFolder("Example Movie (2026)", 2026, 12345);
  assert.equal(out.folder, "Example Movie (2026) [tmdbid-12345]");
  assert.equal(out.file, "Example Movie (2026) [tmdbid-12345].strm");
});

test("series folder uses the TRaSH Jellyfin TVDb id format when available", () => {
  assert.equal(
    seriesFolder("The Office", 2005, { tvdbId: 73244, tmdbId: 2316 }),
    "The Office (2005) [tvdbid-73244]",
  );
});

test("series without TVDb id falls back to Jellyfin TMDb id format", () => {
  assert.equal(
    seriesFolder("Example Show", 2026, { tvdbId: null, tmdbId: 123 }),
    "Example Show (2026) [tmdbid-123]",
  );
});

test("series title does not duplicate an existing year suffix", () => {
  assert.equal(
    seriesFolder("Example Show (2026)", 2026, { tvdbId: 1234 }),
    "Example Show (2026) [tvdbid-1234]",
  );
});

test("episode filename uses title year SxxEyy episode title and TMDb identity", () => {
  assert.equal(
    episodeFile("The Office", 2005, 1, 2, "Diversity Day", 2316),
    "The Office (2005) - S01E02 - Diversity Day [tmdbid-2316].strm",
  );
});

test("episode filename remains usable without an id for legacy cleanup", () => {
  assert.equal(
    episodeFile("The Office", 2005, 1, 2, "Diversity Day"),
    "The Office (2005) - S01E02 - Diversity Day.strm",
  );
});

test("episode titles are capped at the TRaSH 90-character clean-title length", () => {
  const long = "A".repeat(120);
  const file = episodeFile("Example", 2026, 1, 1, long, 99);
  const titlePart = file
    .replace("Example (2026) - S01E01 - ", "")
    .replace(" [tmdbid-99].strm", "");
  assert.equal(titlePart.length, 90);
});

test("cleanTitle produces filesystem-safe readable names", () => {
  assert.equal(cleanTitle("Law & Order: SVU?"), "Law & Order - SVU");
});
