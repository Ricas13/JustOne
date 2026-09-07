import asyncio
import base64
import types

from dlhd_proxy.step_daddy import StepDaddy


class Response:
    def __init__(self, status=200, text="", content=None):
        self.status_code = status
        self.text = text
        self.content = content if content is not None else text.encode()


def source(url):
    encoded = base64.b64encode(url.encode()).decode()
    return f'<script>const p={{source:window.atob("{encoded}")}}</script>'


async def main():
    resolver = StepDaddy()
    root_a = "https://cdn.example/a.m3u8"
    root_b = "https://cdn.example/b.m3u8"
    player = "https://player.example/370"

    async def fake_get(self, url, **kwargs):
        if url == "https://example.invalid/stream/stream-370.php":
            return Response(text=f'<iframe src="{player}" width="100%"></iframe>')
        if any(url == f"https://example.invalid/{family}/stream-370.php" for family in ("watch", "cast", "plus", "player", "casting")):
            return Response(status=404)
        if url == player:
            return Response(text=source(root_a) + source(root_b))
        if url == root_a:
            return Response(text="#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n")
        if url == root_b:
            return Response(text="#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nb.ts\n")
        if url == "https://cdn.example/a.ts":
            return Response(status=503)
        if url == "https://cdn.example/b.ts":
            return Response(status=206, content=b"\x47" + b"\x00" * 4095)
        raise AssertionError(f"unexpected request: {url}")

    resolver._get = types.MethodType(fake_get, resolver)

    refs = await resolver.candidate_refs("370")
    assert refs == [
        {"family": "stream", "embed": 0, "source": 0, "id": "stream:0:0"},
        {"family": "stream", "embed": 0, "source": 1, "id": "stream:0:1"},
    ]

    failed = False
    try:
        await resolver.stream_candidate("370", "stream", 0, 0)
    except ValueError:
        failed = True
    assert failed, "dead candidate must fail its real media probe"

    playlist = await resolver.stream_candidate("370", "stream", 0, 1)
    assert playlist.startswith("#EXTM3U")
    assert "/hls/" in playlist
    await resolver.aclose()


asyncio.run(main())
