import base64
import unittest

from cached_provider import CachedProvider


class FakeResponse:
    def __init__(self, status_code=200, text="", url="https://example.test/"):
        self.status_code = status_code
        self.text = text
        self.url = url
        self.content = text.encode()

    def json(self):
        return {}


def player_html(url: str) -> str:
    encoded = base64.b64encode(url.encode()).decode()
    return f'<script>const player = {{ source: atob("{encoded}") }};</script>'


class FakeCachedProvider(CachedProvider):
    def __init__(self):
        self.channels = []
        self.calls = []
        self._source_cache = {}
        self._source_locks = {}

    async def _get(self, url: str, **kwargs):
        self.calls.append(url)

        if url.endswith("/stream/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://dead.test/player"></iframe>', url)
        if url == "https://dead.test/player":
            return FakeResponse(200, player_html("https://dead.test/live.m3u8"), url)
        if url == "https://dead.test/live.m3u8":
            return FakeResponse(503, "unavailable", url)

        if url.endswith("/watch/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://good1.test/player"></iframe>', url)
        if url == "https://good1.test/player":
            return FakeResponse(200, player_html("https://good1.test/live.m3u8"), url)
        if url == "https://good1.test/live.m3u8":
            return FakeResponse(200, "#EXTM3U\nhttps://good1.test/seg.ts\n", url)

        if url.endswith("/cast/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://good2.test/player"></iframe>', url)
        if url == "https://good2.test/player":
            return FakeResponse(200, player_html("https://good2.test/live.m3u8"), url)
        if url == "https://good2.test/live.m3u8":
            return FakeResponse(200, "#EXTM3U\nhttps://good2.test/seg.ts\n", url)

        return FakeResponse(404, "", url)


class CachedSourceDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_source_then_next_source_reuses_discovery(self):
        provider = FakeCachedProvider()

        with self.assertRaisesRegex(ValueError, "Source 1 via stream unavailable"):
            await provider.stream("54", 0)

        payload = await provider.stream("54", 1)
        self.assertIn("/hls/", payload)

        self.assertEqual(
            provider.calls.count("https://dlive.sx/stream/stream-54.php"),
            1,
        )
        self.assertEqual(
            provider.calls.count("https://dlive.sx/watch/stream-54.php"),
            1,
        )
        self.assertEqual(provider.calls.count("https://dead.test/player"), 1)
        self.assertEqual(provider.calls.count("https://good1.test/player"), 1)
        self.assertEqual(provider.calls.count("https://dead.test/live.m3u8"), 1)
        self.assertEqual(provider.calls.count("https://good1.test/live.m3u8"), 1)

    async def test_source_index_beyond_discovered_options_does_not_rescan(self):
        provider = FakeCachedProvider()

        with self.assertRaisesRegex(ValueError, "Source 6 does not exist"):
            await provider.stream("54", 5)

        first_call_count = len(provider.calls)

        with self.assertRaisesRegex(ValueError, "Source 6 does not exist"):
            await provider.stream("54", 5)

        self.assertEqual(len(provider.calls), first_call_count)


if __name__ == "__main__":
    unittest.main()
