import base64
import unittest

from cached_provider import CachedProvider, NoMoreSourcesError, PLAYER_FOLDERS
from settings import settings


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

        # Player 1: parseable but upstream media is down.
        if url.endswith("/stream/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://dead.test/player"></iframe>', url)
        if url == "https://dead.test/player":
            return FakeResponse(200, player_html("https://dead.test/live.m3u8"), url)
        if url == "https://dead.test/live.m3u8":
            return FakeResponse(503, "unavailable", url)

        # Player 2: browser-generated player. It must remain slot 2 and fail as
        # unavailable, not collapse the source list or claim there are no more.
        if url.endswith("/cast/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://dynamic.test/e/abc"></iframe>', url)
        if url == "https://dynamic.test/e/abc":
            return FakeResponse(200, "<script>window._econfig='opaque';</script>", url)

        # Player 3: ordinary direct HLS.
        if url.endswith("/watch/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://good3.test/player"></iframe>', url)
        if url == "https://good3.test/player":
            return FakeResponse(200, player_html("https://good3.test/live.m3u8"), url)
        if url == "https://good3.test/live.m3u8":
            return FakeResponse(200, "#EXTM3U\nhttps://good3.test/seg.ts\n", url)

        # Player 4: two nested iframe hops before a normal HLS player.
        if url.endswith("/plus/stream-54.php"):
            return FakeResponse(200, '<iframe src="https://wrapper.test/one"></iframe>', url)
        if url == "https://wrapper.test/one":
            return FakeResponse(200, '<iframe src="https://nested.test/player"></iframe>', url)
        if url == "https://nested.test/player":
            return FakeResponse(200, player_html("https://nested.test/live.m3u8"), url)
        if url == "https://nested.test/live.m3u8":
            return FakeResponse(200, "#EXTM3U\nhttps://nested.test/seg.ts\n", url)

        return FakeResponse(404, "", url)


class CachedSourceDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._source_retry_base_seconds = settings.source_retry_base_seconds
        settings.source_retry_base_seconds = 0

    async def asyncTearDown(self):
        settings.source_retry_base_seconds = self._source_retry_base_seconds

    async def test_player_slots_match_site_order(self):
        self.assertEqual(
            PLAYER_FOLDERS,
            ("stream", "cast", "watch", "plus", "casting", "player", "hub"),
        )

    async def test_dead_player_one_does_not_change_player_two_mapping(self):
        provider = FakeCachedProvider()

        with self.assertRaisesRegex(ValueError, "Source 1 via stream unavailable"):
            await provider.stream("54", 0)

        with self.assertRaisesRegex(ValueError, "Source 2 via cast unavailable"):
            await provider.stream("54", 1)

        self.assertIn("https://dynamic.test/e/abc", provider.calls)
        self.assertNotIn("https://good3.test/live.m3u8", provider.calls)

    async def test_unsupported_middle_slot_does_not_hide_later_player(self):
        provider = FakeCachedProvider()

        with self.assertRaisesRegex(ValueError, "dynamic player unsupported"):
            await provider.stream("54", 1)

        payload = await provider.stream("54", 2)
        self.assertIn("/hls/", payload)
        self.assertIn("https://good3.test/live.m3u8", provider.calls)

    async def test_nested_iframes_are_followed_within_one_player_slot(self):
        provider = FakeCachedProvider()

        payload = await provider.stream("54", 3)

        self.assertIn("/hls/", payload)
        self.assertIn("https://wrapper.test/one", provider.calls)
        self.assertIn("https://nested.test/player", provider.calls)
        self.assertIn("https://nested.test/live.m3u8", provider.calls)

    async def test_only_source_index_after_player_seven_means_no_more_sources(self):
        provider = FakeCachedProvider()

        # Player 7 itself is a real slot even when unavailable.
        with self.assertRaisesRegex(ValueError, "Source 7 via hub unavailable"):
            await provider.stream("54", 6)

        # Only source=7 (display Source 8) is beyond the provider slot list.
        with self.assertRaisesRegex(NoMoreSourcesError, "Source 8 does not exist"):
            await provider.stream("54", 7)


if __name__ == "__main__":
    unittest.main()
