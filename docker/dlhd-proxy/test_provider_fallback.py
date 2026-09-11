import base64
import unittest

from provider import Provider


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


class FakeProvider(Provider):
    def __init__(self):
        self.channels = []
        self.calls = []

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


class PlayerFamilyFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_source_zero_skips_dead_primary_family(self):
        provider = FakeProvider()
        payload = await provider.stream("54", 0)

        self.assertIn("/hls/", payload)
        self.assertIn("https://dead.test/live.m3u8", provider.calls)
        self.assertIn("https://good1.test/live.m3u8", provider.calls)
        self.assertNotIn("https://good2.test/live.m3u8", provider.calls)

    async def test_source_one_returns_second_resolvable_family(self):
        provider = FakeProvider()
        payload = await provider.stream("54", 1)

        self.assertIn("/hls/", payload)
        self.assertIn("https://good1.test/live.m3u8", provider.calls)
        self.assertIn("https://good2.test/live.m3u8", provider.calls)


if __name__ == "__main__":
    unittest.main()
