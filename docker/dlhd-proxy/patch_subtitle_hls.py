from pathlib import Path

step_path = Path("dlhd_proxy/step_daddy.py")
text = step_path.read_text()

old_suffix = '''def _direct_hls_suffix(
    url: str,
    *,
    playlist: bool = False,
    key: bool = False,
    init: bool = False,
) -> str:
    """Return an FFmpeg-safe visible suffix for an encrypted HLS proxy URL."""

    if playlist:
        return ".m3u8"
    if key:
        return ".key"

    try:
        suffix = Path(urlparse(url).path).suffix.lower()
    except Exception:
        suffix = ""

    if suffix == ".m3u8":
        return ".m3u8"
    if suffix in _DIRECT_HLS_MEDIA_SUFFIXES:
        return suffix
    if init:
        return ".mp4"

    # DLStreams commonly hides MPEG-TS segment names behind extensionless URLs.
    # FFmpeg's HLS demuxer rejects those before it even makes the HTTP request,
    # so expose a harmless .ts suffix while keeping the encrypted target intact.
    return ".ts"
'''
assert old_suffix in text, "direct HLS suffix helper anchor changed"
new_suffix = '''def _direct_hls_suffix(
    url: str,
    *,
    playlist: bool = False,
    key: bool = False,
    init: bool = False,
    media_kind: str | None = None,
) -> str:
    """Return an FFmpeg-safe visible suffix for an encrypted HLS proxy URL."""

    if playlist:
        return ".m3u8"
    if key:
        return ".key"

    try:
        suffix = Path(urlparse(url).path).suffix.lower()
    except Exception:
        suffix = ""

    if suffix == ".m3u8":
        return ".m3u8"
    if init:
        return suffix if suffix in _DIRECT_HLS_MEDIA_SUFFIXES else ".mp4"

    # Subtitle media playlists frequently use signed/extensionless segment URLs.
    # Those payloads are WebVTT, not MPEG-TS. Carry the rendition type from the
    # master playlist so FFmpeg sees a suffix consistent with the probed format.
    if media_kind == "subtitle":
        if suffix in {".vtt", ".webvtt"}:
            return suffix
        return ".vtt"

    if suffix in _DIRECT_HLS_MEDIA_SUFFIXES:
        return suffix

    # DLStreams commonly hides MPEG-TS segment names behind extensionless URLs.
    # FFmpeg's HLS demuxer rejects those before it even makes the HTTP request,
    # so expose a harmless .ts suffix while keeping the encrypted target intact.
    return ".ts"
'''
text = text.replace(old_suffix, new_suffix, 1)

old_proxy = '''def _direct_hls_proxy_url(
    url: str,
    referer_url: str,
    *,
    playlist: bool = False,
    key: bool = False,
    init: bool = False,
) -> str:
    token = _direct_hls_token(url, referer_url)
    suffix = _direct_hls_suffix(url, playlist=playlist, key=key, init=init)
    return f"{config.api_url}/hls/{token}{suffix}"
'''
assert old_proxy in text, "direct HLS proxy URL helper anchor changed"
new_proxy = '''def _direct_hls_proxy_url(
    url: str,
    referer_url: str,
    *,
    playlist: bool = False,
    key: bool = False,
    init: bool = False,
    media_kind: str | None = None,
) -> str:
    token = _direct_hls_token(url, referer_url)
    suffix = _direct_hls_suffix(
        url,
        playlist=playlist,
        key=key,
        init=init,
        media_kind=media_kind,
    )
    if playlist and media_kind == "subtitle":
        suffix = ".subtitle.m3u8"
    return f"{config.api_url}/hls/{token}{suffix}"
'''
text = text.replace(old_proxy, new_proxy, 1)

old_decode = '''    token = re.sub(
        r"\\.(?:m3u8|ts|m4s|m4a|mp4|aac|mp3|vtt|webvtt|mpegts|m2ts|mts|cmfv|cmfa|fmp4|bin|key)$",
        "",
        str(path),
        flags=re.IGNORECASE,
    )
'''
assert old_decode in text, "direct HLS token suffix anchor changed"
new_decode = '''    token = re.sub(
        r"(?:\\.subtitle)?\\.(?:m3u8|ts|m4s|m4a|mp4|aac|mp3|vtt|webvtt|mpegts|m2ts|mts|cmfv|cmfa|fmp4|bin|key)$",
        "",
        str(path),
        flags=re.IGNORECASE,
    )
'''
text = text.replace(old_decode, new_decode, 1)

old_rewrite_sig = '''def _rewrite_direct_hls_playlist(
    payload: str,
    playlist_url: str,
    referer_url: str | None = None,
) -> str:
'''
assert old_rewrite_sig in text, "direct HLS rewrite signature anchor changed"
new_rewrite_sig = '''def _rewrite_direct_hls_playlist(
    payload: str,
    playlist_url: str,
    referer_url: str | None = None,
    media_kind: str | None = None,
) -> str:
'''
text = text.replace(old_rewrite_sig, new_rewrite_sig, 1)

old_nested_proxy = '''    def proxy_url(
        value: str,
        *,
        playlist: bool = False,
        key: bool = False,
        init: bool = False,
    ) -> str:
        absolute = urljoin(playlist_url, value)
        return _direct_hls_proxy_url(
            absolute,
            referer_url,
            playlist=playlist,
            key=key,
            init=init,
        )
'''
assert old_nested_proxy in text, "direct HLS nested proxy helper anchor changed"
new_nested_proxy = '''    def proxy_url(
        value: str,
        *,
        playlist: bool = False,
        key: bool = False,
        init: bool = False,
        child_media_kind: str | None = None,
    ) -> str:
        absolute = urljoin(playlist_url, value)
        return _direct_hls_proxy_url(
            absolute,
            referer_url,
            playlist=playlist,
            key=key,
            init=init,
            media_kind=child_media_kind or media_kind,
        )
'''
text = text.replace(old_nested_proxy, new_nested_proxy, 1)

old_uri_flags = '''            uri_is_key = bool(re.match(r"#EXT-X-KEY", line, re.IGNORECASE))
            uri_is_init = bool(re.match(r"#EXT-X-MAP", line, re.IGNORECASE))

            if "URI=" in line:
                def replace_uri(match):
                    return (
                        f"{match.group(1)}"
                        f"{proxy_url(match.group(2), playlist=uri_is_playlist, key=uri_is_key, init=uri_is_init)}"
                        f"{match.group(3)}"
                    )
'''
assert old_uri_flags in text, "direct HLS URI rewrite anchor changed"
new_uri_flags = '''            uri_is_key = bool(re.match(r"#EXT-X-KEY", line, re.IGNORECASE))
            uri_is_init = bool(re.match(r"#EXT-X-MAP", line, re.IGNORECASE))
            uri_media_kind = (
                "subtitle"
                if re.search(r"\\bTYPE\\s*=\\s*SUBTITLES\\b", line, re.IGNORECASE)
                else None
            )

            if "URI=" in line:
                def replace_uri(match):
                    return (
                        f"{match.group(1)}"
                        f"{proxy_url(match.group(2), playlist=uri_is_playlist, key=uri_is_key, init=uri_is_init, child_media_kind=uri_media_kind)}"
                        f"{match.group(3)}"
                    )
'''
text = text.replace(old_uri_flags, new_uri_flags, 1)

step_path.write_text(text)

backend_path = Path("dlhd_proxy/backend.py")
backend = backend_path.read_text()

old_unpack = '''    try:
        url, referer = _decode_direct_hls_target(path)
    except Exception as exc:
'''
assert old_unpack in backend, "backend direct HLS decode anchor changed"
new_unpack = '''    media_kind = (
        "subtitle"
        if re.search(r"\\.subtitle\\.m3u8$", str(path), re.IGNORECASE)
        else None
    )
    try:
        url, referer = _decode_direct_hls_target(path)
    except Exception as exc:
'''
backend = backend.replace(old_unpack, new_unpack, 1)

old_rewrite_call = '''            content=_rewrite_direct_hls_playlist(
                payload,
                effective_url,
                referer,
            ),
'''
assert old_rewrite_call in backend, "backend direct HLS rewrite call anchor changed"
new_rewrite_call = '''            content=_rewrite_direct_hls_playlist(
                payload,
                effective_url,
                referer,
                media_kind=media_kind,
            ),
'''
backend = backend.replace(old_rewrite_call, new_rewrite_call, 1)

backend_path.write_text(backend)
