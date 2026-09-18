import test from "node:test";
import assert from "node:assert/strict";
import { deriveXtreamXmltvUrl, duplicateSourceByUrl, normaliseSourceInput, parseBulkPlaylistText } from "../src/sources.js";

test("playlist URL is enough to create a one-connection source", () => {
  const source = normaliseSourceInput({ url: "https://iptv.example.com/get.php?u=abc&p=def" }, []);
  assert.equal(source.name, "iptv.example.com - Line 1");
  assert.equal(source.provider, "iptv.example.com");
  assert.equal(source.account, "Line 1");
  assert.equal(source.maxStreams, 1);
  assert.equal(source.enabled, true);
});

test("Xtream get.php playlists expose the matching XMLTV endpoint", () => {
  const url = "http://iptv.example.com/get.php?username=alice&password=secret&type=m3u_plus&output=mpegts";
  assert.equal(
    deriveXtreamXmltvUrl(url),
    "http://iptv.example.com/xmltv.php?username=alice&password=secret"
  );
  const source = normaliseSourceInput({ url }, []);
  assert.equal(source.detectedEpgUrl, "http://iptv.example.com/xmltv.php?username=alice&password=secret");
  assert.equal(deriveXtreamXmltvUrl("https://iptv.example.com/list.m3u"), "");
});

test("automatic line numbering is per provider", () => {
  const existing = [{ provider: "iptv.example.com", account: "Line 1" }];
  const source = normaliseSourceInput({ url: "https://iptv.example.com/second.m3u" }, existing);
  assert.equal(source.name, "iptv.example.com - Line 2");
  assert.equal(source.account, "Line 2");
});

test("bulk input accepts raw URLs and Name | URL", () => {
  const rows = parseBulkPlaylistText(`
https://a.example/one.m3u
Backup line | https://b.example/two.m3u
# comment
bad row
`);
  assert.deepEqual(rows, [
    { url: "https://a.example/one.m3u" },
    { name: "Backup line", url: "https://b.example/two.m3u" },
    { invalid: "bad row" },
  ]);
});

test("duplicate URL matching is normalized", () => {
  const existing = [{ id: "one", url: "https://a.example/list.m3u" }];
  assert.equal(duplicateSourceByUrl(existing, "https://a.example/list.m3u")?.id, "one");
  assert.equal(duplicateSourceByUrl(existing, "https://b.example/list.m3u"), null);
});


test("blank or null allocator values use safe defaults instead of coercing priority to zero", () => {
  const blank = normaliseSourceInput({
    url: "https://a.example/list.m3u",
    maxStreams: "",
    priority: "",
  }, []);
  assert.equal(blank.maxStreams, 1);
  assert.equal(blank.priority, 10);

  const nulls = normaliseSourceInput({
    url: "https://b.example/list.m3u",
    maxStreams: null,
    priority: null,
  }, [{ id: "existing", provider: "other" }]);
  assert.equal(nulls.maxStreams, 1);
  assert.equal(nulls.priority, 20);

  const explicitZero = normaliseSourceInput({
    url: "https://c.example/list.m3u",
    priority: 0,
  }, []);
  assert.equal(explicitZero.priority, 0);
});
