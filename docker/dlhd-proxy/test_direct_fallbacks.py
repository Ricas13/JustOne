import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from direct_fallbacks import DirectFallbacks, NoDirectFallbackError


class FakeResponse:
    def __init__(self, status_code: int, text: str, url: str):
        self.status_code = status_code
        self.text = text
        self.url = url


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.delay = 0

    def headers(self, referer=None, origin=None):
        headers = {"Referer": referer or ""}
        if origin:
            headers["Origin"] = origin
        return headers

    async def _get_hls_with_retry(self, url, headers, timeout=12):
        self.calls.append((url, dict(headers), timeout))
        if self.delay:
            await asyncio.sleep(self.delay)
        if "dead" in url:
            return FakeResponse(503, "unavailable", url)
        return FakeResponse(
            200,
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n",
            url,
        )


class DirectFallbackTests(unittest.IsolatedAsyncioTestCase):
    def make_config(self, payload):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "direct-fallbacks.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.addCleanup(directory.cleanup)
        return path

    async def test_missing_channel_is_clean_no_fallback(self):
        provider = FakeProvider()
        path = self.make_config({"10": "https://example.test/live.m3u8"})
        fallbacks = DirectFallbacks(provider, path)

        with self.assertRaisesRegex(NoDirectFallbackError, "channel 49"):
            await fallbacks.stream("49")
        self.assertEqual(provider.calls, [])

    async def test_direct_hls_is_rewritten_through_justone_proxy(self):
        provider = FakeProvider()
        path = self.make_config({
            "49": {
                "url": "https://example.test/live/index.m3u8",
                "referer": "https://example.test/player/",
                "origin": "https://example.test",
            }
        })
        fallbacks = DirectFallbacks(provider, path)

        payload = await fallbacks.stream("49")

        self.assertIn("#EXTM3U", payload)
        self.assertIn("/hls/", payload)
        self.assertEqual(len(provider.calls), 1)
        url, headers, timeout = provider.calls[0]
        self.assertEqual(url, "https://example.test/live/index.m3u8")
        self.assertEqual(headers["Referer"], "https://example.test/player/")
        self.assertEqual(headers["Origin"], "https://example.test")
        self.assertEqual(timeout, 12)

    async def test_failed_fallback_advances_to_next_configured_source(self):
        provider = FakeProvider()
        path = self.make_config({
            "49": [
                "https://dead.example/live.m3u8",
                "https://good.example/live.m3u8",
            ]
        })
        fallbacks = DirectFallbacks(provider, path)

        payload = await fallbacks.stream("49")

        self.assertIn("/hls/", payload)
        self.assertEqual([call[0] for call in provider.calls], [
            "https://dead.example/live.m3u8",
            "https://good.example/live.m3u8",
        ])

    async def test_concurrent_requests_share_one_resolution(self):
        provider = FakeProvider()
        provider.delay = 0.05
        path = self.make_config({"49": "https://good.example/live.m3u8"})
        fallbacks = DirectFallbacks(provider, path)

        first, second = await asyncio.gather(
            fallbacks.stream("49"),
            fallbacks.stream("49"),
        )

        self.assertEqual(first, second)
        self.assertEqual(len(provider.calls), 1)

    async def test_invalid_urls_are_ignored(self):
        provider = FakeProvider()
        path = self.make_config({"49": ["file:///tmp/a.m3u8", "not-a-url"]})
        fallbacks = DirectFallbacks(provider, path)

        self.assertFalse(fallbacks.has_channel("49"))
        with self.assertRaises(NoDirectFallbackError):
            await fallbacks.stream("49")


if __name__ == "__main__":
    unittest.main()
