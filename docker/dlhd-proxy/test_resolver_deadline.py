import asyncio
import unittest

import app as app_module


class ResolverDeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_stream = app_module.provider.stream
        self.original_invalidate = app_module.provider.invalidate
        self.original_timeout = app_module.settings.source_resolve_timeout_seconds
        app_module.stream_inflight.clear()

    async def asyncTearDown(self):
        for task in list(app_module.stream_inflight.values()):
            task.cancel()
        if app_module.stream_inflight:
            await asyncio.gather(*app_module.stream_inflight.values(), return_exceptions=True)
        app_module.stream_inflight.clear()
        app_module.provider.stream = self.original_stream
        app_module.provider.invalidate = self.original_invalidate
        app_module.settings.source_resolve_timeout_seconds = self.original_timeout

    async def test_slow_resolution_is_cancelled_before_ffmpeg_timeout(self):
        invalidated = []

        async def slow_stream(channel_id, source):
            await asyncio.sleep(1)
            return "#EXTM3U\n"

        app_module.provider.stream = slow_stream
        app_module.provider.invalidate = lambda channel_id: invalidated.append(str(channel_id))
        app_module.settings.source_resolve_timeout_seconds = 0.01

        with self.assertRaises(asyncio.TimeoutError):
            await app_module._resolve_stream("36", 0, False)

        await asyncio.sleep(0)
        self.assertEqual(invalidated, ["36"])
        self.assertNotIn(("36", 0, False), app_module.stream_inflight)


if __name__ == "__main__":
    unittest.main()
