import test from "node:test";
import assert from "node:assert/strict";
import { advertisedQuality } from "../src/services/qualityAvailability.js";

test("unknown source metadata stays unknown rather than being guessed as non-4K", () => {
  assert.equal(
    advertisedQuality({ url: "https://cdn.example/video/master.m3u8", provider: "source" }),
    "unknown",
  );
});
