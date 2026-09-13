import asyncio
import unittest

from hls_resilience import (
    HLSResilience,
    UpstreamObjectError,
    extract_media_segment_urls,
    inject_live_start_offset,
    prune_audio_renditions,
)
from settings import settings


class FakeResponse:
    def __init__(self, url, status_code=200, body=b"ok", headers=None):
        self.url = url
        self.status_code = status_code
        self.content = body
        self.headers = headers or {"content-type": "video/mp2t", "content-length": str(len(body))}


class FakeClient:
    def __init__(self, responses):
        self.responses = {url: list(items) for url, items in responses.items()}
        self.calls = []

    async def get(self, url, **_kwargs):
        self.calls.append(url)
        await asyncio.sleep(0)
        queue = self.responses[url]
        if len(queue) > 1:
            return queue.pop(0)
        return queue[0]


class HLSPlaylistTests(unittest.TestCase):
    def test_prunes_secondary_audio_renditions_but_keeps_first(self):
        payload = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Primary",DEFAULT=NO,URI="tracks-a1/mono.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Secondary",DEFAULT=YES,URI="tracks-a2/mono.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="audio"
tracks-v1a1/mono.m3u8
"""
        result = prune_audio_renditions(payload)
        self.assertIn("tracks-a1/mono.m3u8", result)
        self.assertNotIn("tracks-a2/mono.m3u8", result)
        self.assertIn("tracks-v1a1/mono.m3u8", result)

    def test_live_start_offset_only_applies_to_live_media_playlist(self):
        live = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n1.ts\n"
        result = inject_live_start_offset(live, 12)
        self.assertIn("#EXT-X-START:TIME-OFFSET=-12,PRECISE=YES", result)

        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"
        self.assertNotIn("#EXT-X-START", inject_live_start_offset(master, 12))

        vod = "#EXTM3U\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST\n"
        self.assertNotIn("#EXT-X-START", inject_live_start_offset(vod, 12))

    def test_extracts_only_media_segments(self):
        payload = "#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:4,\n../b.jpg?token=x\n"
        self.assertEqual(
            extract_media_segment_urls(payload, "https://cdn.test/path/live.m3u8"),
            ["https://cdn.test/path/a.ts", "https://cdn.test/b.jpg?token=x"],
        )


class HLSResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original = {
            "hls_segment_retry_attempts": settings.hls_segment_retry_attempts,
            "hls_retry_base_seconds": settings.hls_retry_base_seconds,
            "hls_prefetch_segments": settings.hls_prefetch_segments,
            "hls_segment_cache_items": settings.hls_segment_cache_items,
            "hls_segment_cache_max_mb": settings.hls_segment_cache_max_mb,
            "hls_segment_cache_ttl_seconds": settings.hls_segment_cache_ttl_seconds,
        }
        settings.hls_segment_retry_attempts = 2
        settings.hls_retry_base_seconds = 0.001
        settings.hls_prefetch_segments = 0
        settings.hls_segment_cache_items = 16
        settings.hls_segment_cache_max_mb = 16
        settings.hls_segment_cache_ttl_seconds = 60

    async def asyncTearDown(self):
        for key, value in self.original.items():
            setattr(settings, key, value)

    async def test_concurrent_identical_segment_requests_share_one_upstream_fetch(self):
        url = "https://cdn.test/one.ts"
        client = FakeClient({url: [FakeResponse(url, body=b"segment")]})
        manager = HLSResilience(client)
        headers = {"Referer": "https://player.test/"}

        first, second = await asyncio.gather(
            manager.fetch_segment(url, headers),
            manager.fetch_segment(url, headers),
        )
        third = await manager.fetch_segment(url, headers)

        self.assertEqual(first.body, b"segment")
        self.assertEqual(second.body, b"segment")
        self.assertEqual(third.body, b"segment")
        self.assertEqual(client.calls.count(url), 1)
        await manager.close()

    async def test_transient_503_is_retried_but_403_is_not(self):
        transient = "https://cdn.test/transient.ts"
        forbidden = "https://cdn.test/forbidden.ts"
        client = FakeClient({
            transient: [
                FakeResponse(transient, status_code=503, body=b"down", headers={}),
                FakeResponse(transient, status_code=200, body=b"good"),
            ],
            forbidden: [FakeResponse(forbidden, status_code=403, body=b"no", headers={})],
        })
        manager = HLSResilience(client)
        headers = {"Referer": "https://player.test/"}

        recovered = await manager.fetch_segment(transient, headers)
        self.assertEqual(recovered.body, b"good")
        self.assertEqual(client.calls.count(transient), 2)

        with self.assertRaises(UpstreamObjectError) as ctx:
            await manager.fetch_segment(forbidden, headers)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(client.calls.count(forbidden), 1)
        await manager.close()

    async def test_player_request_prefetches_next_segments_into_shared_cache(self):
        settings.hls_prefetch_segments = 2
        one = "https://cdn.test/1.ts"
        two = "https://cdn.test/2.ts"
        three = "https://cdn.test/3.ts"
        client = FakeClient({
            one: [FakeResponse(one, body=b"one")],
            two: [FakeResponse(two, body=b"two")],
            three: [FakeResponse(three, body=b"three")],
        })
        manager = HLSResilience(client)
        headers = {"Referer": "https://player.test/"}
        manager.register_playlist("https://cdn.test/live.m3u8", [one, two, three], headers)

        await manager.fetch_segment(one, headers)
        if manager.background_tasks:
            await asyncio.gather(*list(manager.background_tasks))

        self.assertEqual(client.calls.count(one), 1)
        self.assertEqual(client.calls.count(two), 1)
        self.assertEqual(client.calls.count(three), 1)

        await manager.fetch_segment(two, headers)
        self.assertEqual(client.calls.count(two), 1)
        await manager.close()


if __name__ == "__main__":
    unittest.main()
