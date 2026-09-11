from pathlib import Path

backend_path = Path("dlhd_proxy/backend.py")
backend = backend_path.read_text()

route_anchor = '@fastapi_app.get("/hls/{path}")\nasync def hls_content(path: str):\n'
assert route_anchor in backend, "backend HLS route anchor changed"

helpers = r'''_HLS_PROGRESS = {}


def _stable_hls_path(value: str, base_url: str | None = None) -> str:
    """Return a token/query-insensitive identity for an HLS URI."""

    import re
    from urllib.parse import urljoin, urlparse

    absolute = urljoin(base_url, value) if base_url else str(value)
    parsed = urlparse(absolute)
    path = re.sub(
        r"/secure/[^/]+/\d+/",
        "/secure/_/_/",
        parsed.path or "",
        flags=re.IGNORECASE,
    )
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def _hls_stall_reason(payload: str, playlist_url: str, now: float | None = None):
    """Detect a live media playlist that returns 200 but no longer advances."""

    import os
    import re
    import time

    lines = [line.strip() for line in str(payload or "").splitlines() if line.strip()]
    upper = [line.upper() for line in lines]

    # Master/VOD playlists are not live media edges and must not be judged by
    # media-sequence progress.
    if any(line.startswith("#EXT-X-STREAM-INF") for line in upper):
        return None
    if any(line.startswith("#EXT-X-ENDLIST") for line in upper):
        return None

    has_media = any(line.startswith("#EXTINF:") or line.startswith("#EXT-X-PART:") for line in upper)
    if not has_media:
        return None

    segment_uris = [line for line in lines if not line.startswith("#")]
    latest_uri = segment_uris[-1] if segment_uris else None

    part_uris = []
    for line in lines:
        if not (line.upper().startswith("#EXT-X-PART:") or line.upper().startswith("#EXT-X-PRELOAD-HINT:")):
            continue
        match = re.search(r'URI=["\']([^"\']+)["\']', line, re.IGNORECASE)
        if match:
            part_uris.append(match.group(1))
    latest_part = part_uris[-1] if part_uris else None
    if not latest_uri and latest_part:
        latest_uri = latest_part
    if not latest_uri:
        return None

    sequence = ""
    for line in lines:
        if line.upper().startswith("#EXT-X-MEDIA-SEQUENCE:"):
            sequence = line.split(":", 1)[1].strip()
            break

    target_duration = 4.0
    for line in lines:
        if line.upper().startswith("#EXT-X-TARGETDURATION:"):
            try:
                target_duration = max(0.5, float(line.split(":", 1)[1].strip()))
            except ValueError:
                pass
            break

    try:
        multiplier = float(os.getenv("DLHD_HLS_STALL_TARGET_MULTIPLIER", "3"))
    except ValueError:
        multiplier = 3.0
    try:
        minimum = float(os.getenv("DLHD_HLS_STALL_MIN_SECONDS", "12"))
    except ValueError:
        minimum = 12.0
    try:
        maximum = float(os.getenv("DLHD_HLS_STALL_MAX_SECONDS", "30"))
    except ValueError:
        maximum = 30.0

    multiplier = max(1.0, min(10.0, multiplier))
    minimum = max(4.0, min(120.0, minimum))
    maximum = max(minimum, min(300.0, maximum))
    stall_after = max(minimum, min(maximum, target_duration * multiplier))

    timestamp = time.monotonic() if now is None else float(now)
    key = _stable_hls_path(playlist_url)
    part_marker = _stable_hls_path(latest_part, playlist_url) if latest_part else ""
    marker = f"{sequence}|{_stable_hls_path(latest_uri, playlist_url)}|{part_marker}"
    state = _HLS_PROGRESS.get(key)

    # If this playlist has not been observed for a while, treat the next view as
    # a fresh session instead of inheriting stale timing from an old viewer.
    idle_reset_after = max(120.0, stall_after * 4.0)
    if (
        state is None
        or state.get("marker") != marker
        or timestamp - float(state.get("seen_at", timestamp)) > idle_reset_after
    ):
        _HLS_PROGRESS[key] = {
            "marker": marker,
            "changed_at": timestamp,
            "seen_at": timestamp,
        }
        return None

    state["seen_at"] = timestamp
    elapsed = timestamp - float(state.get("changed_at", timestamp))
    if elapsed < stall_after:
        return None

    return (
        f"live edge unchanged for {elapsed:.1f}s "
        f"(limit {stall_after:.1f}s, target {target_duration:.1f}s)"
    )


def _reset_hls_progress_for_tests():
    _HLS_PROGRESS.clear()


'''
backend = backend.replace(route_anchor, helpers + route_anchor, 1)

validation_anchor = '''        if not payload.lstrip().startswith("#EXTM3U"):
            logger.warning("Direct-HLS child was not a playlist: %s", effective_url)
            return JSONResponse(
                content={"error": "Upstream HLS playlist was invalid"},
                status_code=status.HTTP_502_BAD_GATEWAY,
            )
'''
assert validation_anchor in backend, "backend HLS playlist validation anchor changed"

stall_check = '''
        stall_reason = _hls_stall_reason(payload, effective_url)
        if stall_reason:
            logger.warning(
                "Direct-HLS live playlist stalled for %s: %s",
                effective_url,
                stall_reason,
            )
            return JSONResponse(
                content={"error": "Upstream HLS playlist stalled"},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                headers={"Retry-After": "1"},
            )
'''
backend = backend.replace(validation_anchor, validation_anchor + stall_check, 1)
backend_path.write_text(backend)
