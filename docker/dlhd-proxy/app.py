import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response

from cached_provider import CachedProvider, NoMoreSourcesError
from direct_fallbacks import DirectFallbacks, NoDirectFallbackError
from hls_resilience import (
    HLSResilience,
    UpstreamObjectError,
    extract_media_segment_urls,
    prepare_hls_playlist,
)
from provider import decode_target, rewrite_hls_playlist
from settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("justone.dlhd")

provider = CachedProvider()
direct_fallbacks = DirectFallbacks(provider)
client = httpx.AsyncClient(
    http2=True,
    timeout=httpx.Timeout(15.0, read=60.0),
    follow_redirects=True,
    verify=False,
)
hls_resilience = HLSResilience(client)
refresh_task: asyncio.Task | None = None
stream_inflight: dict[tuple[str, int, bool], asyncio.Task] = {}


async def refresh_channels_forever() -> None:
    while True:
        try:
            await asyncio.sleep(settings.refresh_seconds)
            await provider.load_channels()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Channel refresh failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global refresh_task
    try:
        await provider.load_channels()
    except Exception:
        logger.exception("Initial channel load failed")
    refresh_task = asyncio.create_task(refresh_channels_forever())
    try:
        yield
    finally:
        if refresh_task:
            refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await refresh_task
        for task in list(stream_inflight.values()):
            task.cancel()
        stream_inflight.clear()
        await hls_resilience.close()
        await client.aclose()
        await provider.close()


app = FastAPI(title="JustOne DLHD", lifespan=lifespan)


def m3u_escape(value: str) -> str:
    return str(value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


def _origin_from_referer(referer: str) -> str:
    """Return the normal HTTP Origin corresponding to a proxied Referer."""
    try:
        parsed = urlparse(str(referer or ""))
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _empty_media_playlist(payload: str) -> bool:
    """Detect media playlists that advertise segments but provide no segment URIs."""
    lines = [line.strip() for line in str(payload or "").splitlines() if line.strip()]
    if any(line.upper().startswith("#EXT-X-STREAM-INF") for line in lines):
        return False
    has_extinf = any(line.upper().startswith("#EXTINF:") for line in lines)
    has_media_uri = any(not line.startswith("#") for line in lines)
    return has_extinf and not has_media_uri


async def _resolve_stream(channel_id: str, source: int, refresh: bool) -> str:
    key = (channel_id, source, refresh)
    task = stream_inflight.get(key)
    if task is None:
        if refresh:
            provider.invalidate(channel_id)
        task = asyncio.create_task(provider.stream(channel_id, source))
        stream_inflight[key] = task

        def clear(done: asyncio.Task, request_key=key) -> None:
            if stream_inflight.get(request_key) is done:
                stream_inflight.pop(request_key, None)

        task.add_done_callback(clear)

    try:
        return await asyncio.wait_for(
            asyncio.shield(task),
            timeout=settings.source_resolve_timeout_seconds,
        )
    except asyncio.TimeoutError:
        if stream_inflight.get(key) is task:
            stream_inflight.pop(key, None)
        if not task.done():
            task.cancel()
        provider.invalidate(channel_id)
        raise


def _upstream_error_response(exc: UpstreamObjectError) -> JSONResponse:
    headers = {}
    if exc.retry_after:
        headers["Retry-After"] = exc.retry_after
    return JSONResponse(
        {"error": exc.message, "status": exc.status_code},
        status_code=exc.status_code,
        headers=headers,
    )


@app.get("/health")
async def health():
    return {
        "ok": bool(provider.channels),
        "channels": len(provider.channels),
        "mode": "ordered-sources-resilient-hls",
        "hls": hls_resilience.stats(),
        "direct_fallbacks": direct_fallbacks.summary(),
    }


@app.get("/channels")
async def channels():
    return [channel.__dict__ for channel in provider.channels]


@app.get("/playlist.m3u8")
async def playlist():
    lines = ["#EXTM3U"]
    for channel in provider.channels:
        name = m3u_escape(channel.name)
        lines.append(
            f'#EXTINF:-1 tvg-id="dlhd-{channel.id}" tvg-name="{name}" group-title="DLHD",{name}'
        )
        lines.append(f"{settings.api_url}/stream/{channel.id}.m3u8")
    return Response(
        content="\n".join(lines) + "\n",
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/stream/{channel_id}.m3u8")
async def stream(
    channel_id: str,
    source: int = Query(default=0, ge=0, le=20),
    refresh: bool = Query(default=False),
):
    try:
        body = await _resolve_stream(channel_id, source, refresh)
    except asyncio.TimeoutError:
        logger.warning(
            "Channel %s source %s resolution timed out after %.1fs",
            channel_id,
            source + 1,
            settings.source_resolve_timeout_seconds,
        )
        return JSONResponse(
            {
                "error": "source resolution timed out",
                "channel": channel_id,
                "source": source + 1,
                "retryable": True,
            },
            status_code=504,
            headers={"Retry-After": "1", "X-JustOne-Retryable": "1"},
        )
    except NoMoreSourcesError as exc:
        logger.info("Channel %s has no source slot %s: %s", channel_id, source + 1, exc)
        return JSONResponse(
            {"error": str(exc), "channel": channel_id, "source": source + 1, "no_more_sources": True},
            status_code=404,
            headers={"X-JustOne-No-More-Sources": "1"},
        )
    except ValueError as exc:
        logger.warning("Channel %s source %s unavailable: %s", channel_id, source + 1, exc)
        return JSONResponse(
            {"error": str(exc), "channel": channel_id, "source": source + 1},
            status_code=502,
        )
    except Exception as exc:
        logger.exception("Channel %s source %s failed", channel_id, source + 1)
        return JSONResponse(
            {"error": str(exc), "channel": channel_id, "source": source + 1},
            status_code=502,
        )

    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/fallback/{channel_id}.m3u8")
async def fallback_stream(
    channel_id: str,
    refresh: bool = Query(default=False),
):
    try:
        body = await asyncio.wait_for(
            direct_fallbacks.stream(channel_id, refresh=refresh),
            timeout=settings.source_resolve_timeout_seconds,
        )
    except NoDirectFallbackError as exc:
        return JSONResponse(
            {"error": str(exc), "channel": channel_id, "configured": False},
            status_code=404,
            headers={"X-JustOne-No-Direct-Fallback": "1"},
        )
    except asyncio.TimeoutError:
        logger.warning("Channel %s direct fallback resolution timed out", channel_id)
        return JSONResponse(
            {"error": "direct fallback resolution timed out", "channel": channel_id, "retryable": True},
            status_code=504,
            headers={"Retry-After": "1", "X-JustOne-Retryable": "1"},
        )
    except ValueError as exc:
        logger.warning("Channel %s direct fallback unavailable: %s", channel_id, exc)
        return JSONResponse(
            {"error": str(exc), "channel": channel_id},
            status_code=502,
        )
    except Exception as exc:
        logger.exception("Channel %s direct fallback failed", channel_id)
        return JSONResponse(
            {"error": str(exc), "channel": channel_id},
            status_code=502,
        )

    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/hls/{path:path}")
async def hls(path: str):
    try:
        url, referer, origin = decode_target(path)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    effective_origin = origin or _origin_from_referer(referer)
    headers = provider.headers(referer, effective_origin or None)
    is_playlist = path.lower().endswith(".m3u8")

    if is_playlist:
        try:
            fetched = await hls_resilience.fetch_playlist(url, headers)
        except UpstreamObjectError as exc:
            logger.warning(
                "HLS playlist failed status=%s url=%s retry_after=%r",
                exc.status_code,
                url,
                exc.retry_after,
            )
            return _upstream_error_response(exc)

        body = fetched.body.decode("utf-8", errors="replace")
        if not body.lstrip().startswith("#EXTM3U"):
            preview = body[:300].replace("\n", " ").replace("\r", " ")
            logger.warning(
                "Invalid HLS playlist status=%s content_type=%r url=%s body_preview=%r",
                fetched.status_code,
                fetched.content_type,
                fetched.effective_url,
                preview,
            )
            return JSONResponse({"error": "invalid upstream HLS playlist"}, status_code=502)

        prepared = prepare_hls_playlist(body)
        if _empty_media_playlist(prepared):
            logger.warning(
                "Empty HLS media playlist url=%s referer=%s origin=%s",
                fetched.effective_url,
                referer,
                effective_origin,
            )
            return JSONResponse(
                {"error": "upstream HLS playlist contains segment durations but no media URIs"},
                status_code=502,
                headers={"X-JustOne-Retryable": "1"},
            )

        segments = extract_media_segment_urls(prepared, fetched.effective_url)
        if segments:
            hls_resilience.register_playlist(fetched.effective_url, segments, headers)

        return Response(
            content=rewrite_hls_playlist(prepared, fetched.effective_url, referer),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    try:
        fetched = await hls_resilience.fetch_segment(url, headers)
    except UpstreamObjectError as exc:
        logger.warning(
            "HLS object failed status=%s url=%s retry_after=%r",
            exc.status_code,
            url,
            exc.retry_after,
        )
        return _upstream_error_response(exc)

    return Response(
        content=fetched.body,
        media_type=fetched.content_type,
        headers={"Cache-Control": "no-store"},
    )
