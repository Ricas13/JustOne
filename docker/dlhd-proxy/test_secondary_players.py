import asyncio
import base64
import types

from dlhd_proxy.step_daddy import StepDaddy, _extract_direct_hls_sources


class Response:
    def __init__(self, status=200, text="", content=None):
        self.status_code = status
        self.text = text
        self.content = content if content is not None else text.encode()


def source(url):
    encoded = base64.b64encode(url.encode()).decode()
    return f'<script>const p={{source:window.atob("{encoded}")}}</script>'


def media(segment="seg.ts"):
    return f"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n{segment}\n"


async def test_multiple_embedded_sources():
    bad_root = "https://cdn.example/ch49-bad.m3u8"
    good_root = "https://cdn.example/ch49-good.m3u8"
    player = "https://player.example/ch49"
    calls = []

    page = source(bad_root) + source(good_root)
    assert _extract_direct_hls_sources(page) == [bad_root, good_root]

    async def fake_get(self, url, **kwargs):
        calls.append(url)
        table = {
            "https://example.invalid/stream/stream-49.php": Response(
                text=f'<iframe src="{player}" width="100%"></iframe>'
            ),
            player: Response(text=page),
            bad_root: Response(text="#EXTM3U\n#EXT-X-TARGETDURATION:4\n"),
            good_root: Response(text=media()),
            "https://cdn.example/seg.ts": Response(
                status=206,
                content=b"\x47" + b"\x00" * 4095,
            ),
        }
        if url not in table:
            raise AssertionError(f"unexpected request: {url}")
        return table[url]

    resolver = StepDaddy()
    resolver._get = types.MethodType(fake_get, resolver)
    out = await resolver.stream("49")
    assert out.startswith("#EXTM3U")
    assert resolver._player_folder_cache["49"] == {
        "folder": "stream",
        "embed": 0,
        "source": 1,
    }
    assert bad_root in calls and good_root in calls

    # The winning source index is cached, so the next tune should probe source
    # two first rather than repeatedly waiting for the known-dead source one.
    calls.clear()
    out = await resolver.stream("49")
    assert out.startswith("#EXTM3U")
    assert good_root in calls
    assert bad_root not in calls
    await resolver.aclose()


async def test_multiple_iframes():
    bad_player = "https://player.example/ch50-a"
    good_player = "https://player.example/ch50-b"
    bad_root = "https://cdn.example/ch50-bad.m3u8"
    good_root = "https://cdn.example/ch50-good.m3u8"
    calls = []

    async def fake_get(self, url, **kwargs):
        calls.append(url)
        table = {
            "https://example.invalid/stream/stream-50.php": Response(
                text=(
                    f'<iframe src="{bad_player}" width="100%"></iframe>'
                    f'<iframe src="{good_player}" width="100%"></iframe>'
                )
            ),
            bad_player: Response(text=source(bad_root)),
            good_player: Response(text=source(good_root)),
            bad_root: Response(text="#EXTM3U\n#EXT-X-TARGETDURATION:4\n"),
            good_root: Response(text=media("seg50.ts")),
            "https://cdn.example/seg50.ts": Response(
                status=206,
                content=b"\x47" + b"\x00" * 4095,
            ),
        }
        if url not in table:
            raise AssertionError(f"unexpected request: {url}")
        return table[url]

    resolver = StepDaddy()
    resolver._get = types.MethodType(fake_get, resolver)
    out = await resolver.stream("50")
    assert out.startswith("#EXTM3U")
    assert resolver._player_folder_cache["50"] == {
        "folder": "stream",
        "embed": 1,
        "source": 0,
    }
    assert bad_player in calls and good_player in calls
    assert "https://example.invalid/watch/stream-50.php" not in calls

    # Same optimisation for the second iframe: next tune goes straight to it.
    calls.clear()
    out = await resolver.stream("50")
    assert out.startswith("#EXTM3U")
    assert good_player in calls
    assert bad_player not in calls
    await resolver.aclose()


async def main():
    await test_multiple_embedded_sources()
    await test_multiple_iframes()


asyncio.run(main())
