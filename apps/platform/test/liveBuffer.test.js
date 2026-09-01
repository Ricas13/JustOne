import test from "node:test";
import assert from "node:assert/strict";
import { liveBufferSettings, StartupMediaBuffer } from "../src/liveBuffer.js";

test("live buffer defaults to five seconds and a 64 MiB cap", () => {
  const settings = liveBufferSettings({});
  assert.equal(settings.seconds, 5);
  assert.equal(settings.delayMs, 5000);
  assert.equal(settings.maxBytes, 64 * 1024 * 1024);
});

test("live buffer can be disabled and clamps excessive delay", () => {
  assert.equal(liveBufferSettings({ LIVE_BUFFER_SECONDS: "0" }).delayMs, 0);
  assert.equal(liveBufferSettings({ LIVE_BUFFER_SECONDS: "999" }).seconds, 30);
});

test("startup media buffer preserves byte order and releases once", () => {
  const buffer = new StartupMediaBuffer(6);
  assert.equal(buffer.push(Buffer.from("ab")).full, false);
  assert.equal(buffer.push(Buffer.from("cd")).full, false);
  assert.equal(buffer.push(Buffer.from("ef")).full, true);
  assert.equal(buffer.bytes, 6);
  assert.equal(buffer.release().toString("utf8"), "abcdef");
  assert.equal(buffer.bytes, 0);
  assert.equal(buffer.release().length, 0);
  assert.equal(buffer.push(Buffer.from("gh")).accepted, false);
});
