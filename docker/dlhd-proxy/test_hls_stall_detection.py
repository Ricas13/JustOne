from dlhd_proxy.backend import _hls_stall_reason, _reset_hls_progress_for_tests


def live(sequence: int, segment: str):
    return (
        "#EXTM3U\n"
        "#EXT-X-TARGETDURATION:4\n"
        f"#EXT-X-MEDIA-SEQUENCE:{sequence}\n"
        "#EXTINF:4,\n"
        f"{segment}\n"
    )


def main():
    url_a = (
        "https://xameleon.example/two/secure/aaaaaaaa/1789158198/"
        "premium49/tracks-v1a1/mono.m3u8"
    )
    url_b = (
        "https://xameleon.example/two/secure/bbbbbbbb/1789158229/"
        "premium49/tracks-v1a1/mono.m3u8"
    )
    segment_a = (
        "https://r2.example/File_8042514673.zst?X-Amz-Date=20260911T172318Z&sig=old"
    )
    segment_b = (
        "https://r2.example/File_9988776655.zst?X-Amz-Date=20260911T172330Z&sig=new"
    )

    _reset_hls_progress_for_tests()
    assert _hls_stall_reason(live(100, segment_a), url_a, now=100.0) is None
    assert _hls_stall_reason(live(100, segment_a), url_a, now=111.9) is None

    # Rotating the signed /secure/<token>/<expiry>/ URL must not hide a media
    # playlist whose live edge is still exactly the same segment.
    reason = _hls_stall_reason(live(100, segment_a), url_b, now=112.1)
    assert reason is not None
    assert "live edge unchanged" in reason

    # A genuinely new media sequence/segment clears the stall immediately.
    assert _hls_stall_reason(live(101, segment_b), url_b, now=112.2) is None
    assert _hls_stall_reason(live(101, segment_b), url_b, now=124.0) is None

    # Master playlists and finite/VOD media must never be classified as stalled.
    master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n"
    vod = live(1, "one.ts") + "#EXT-X-ENDLIST\n"
    _reset_hls_progress_for_tests()
    assert _hls_stall_reason(master, url_a, now=1.0) is None
    assert _hls_stall_reason(master, url_a, now=1000.0) is None
    assert _hls_stall_reason(vod, url_a, now=1.0) is None
    assert _hls_stall_reason(vod, url_a, now=1000.0) is None


main()
