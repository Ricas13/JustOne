import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from cached_provider import CachedProvider, NoMoreSourcesError
from provider import decode_target, rewrite_hls_playlist
from settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("justone.dlhd")

PLAYLIST_TIMEOUT_SECONDS = 8.0
PLAYLIST_CACHE_SECONDS = 1.0

provider = CachedProvider()
client = httpx.AsyncClient(
    http2=True,
    timeout=httpx.Timeout(15.0, read=60.0),
    follow_redirects=True,
    verify=False,
)
refresh_task: asyncio.Task | None = None
playlist_cache: dict[tuple[str, str, str], tuple[float, str]] = {}
playlist_inflight: dict[tuple[str, str, str], asyncio.Task] = {}


class UpstreamPlaylistError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


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
        for task in list(playlist_inflight.values()):
            task.cancel()
        playlist_inflight.clear()
        playlist_cache.clear()
        await client.aclose()
        await provider.close()


app = FastAPI(title="JustOne DLHD", lifespan=lifespan)


def m3u_escape(value: str) -> str:
    return str(value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


def _playlist_key(url: str, referer: str, origin: str) -> tuple[str, str, str]:
    return (url, referer or "", origin or "")


async def _load_playlist(url: str, referer: str, origin: str) -> str:
    response = None
    try:
        response = await client.send(
            client.build_request(
                "GET",
                url,
                headers=provider.headers(referer, origin or None),
                timeout=httpx.Timeout(PLAYLIST_TIMEOUT_SECONDS),
            ),
            stream=True,
        )
    except httpx.RequestError as exc:
        logger.warning("HLS playlist request failed %s: %s", url, exc)
        raise UpstreamPlaylistError(502, "upstream HLS playlist unavailable") from exc

    try:
        if response.status_code >= 400:
            logger.warning(
                "HLS playlist upstream error status=%s url=%s retry_after=%r server=%r cf_ray=%r",
                response.status_code,
                url,
                response.headers.get("retry-after"),
                response.headers.get("server"),
                response.headers.get("cf-ray"),
            )
            raise UpstreamPlaylistError(response.status_code, "upstream HLS error")

        effective_url = str(response.url)
        content_type = response.headers.get("content-type", "application/octet-stream")
        try:
            raw = await response.aread()
        except httpx.RequestError as exc:
            logger.warning("HLS playlist body read failed %s: %s", effective_url, exc)
            raise UpstreamPlaylistError(502, "upstream HLS playlist read failed") from exc

        body = raw.decode("utf-8", errors="replace")
        if not body.lstrip().startswith("#EXTM3U"):
            preview = body[:500].replace("\n", " ").replace("\r", " ")
            logger.warning(
                "INVALID HLS PLAYLIST status=%s content_type=%r effective_url=%s "
                "content_length=%r server=%r cf_ray=%r body_preview=%r",
                response.status_code,
                content_type,
                effective_url,
                response.headers.get("content-length"),
                response.headers.get("server"),
                response.headers.get("cf-ray"),
                preview,
            )
            raise UpstreamPlaylistError(502, "invalid upstream HLS playlist")

        return rewrite_hls_playlist(body, effective_url, referer)
    finally:
        with suppress(Exception):
            await response.aclose()


async def _load_and_cache_playlist(
    key: tuple[str, str, str],
    url: str,
    referer: str,
    origin: str,
) -> str:
    body = await _load_playlist(url, referer, origin)
    playlist_cache[key] = (
        asyncio.get_running_loop().time() + PLAYLIST_CACHE_SECONDS,
        body,
    )
    return body


async def get_playlist(url: str, referer: str, origin: str) -> str:
    loop = asyncio.get_running_loop()
    key = _playlist_key(url, referer, origin)
    cached = playlist_cache.get(key)
    if cached:
        expires_at, body = cached
        if expires_at > loop.time():
            return body
        playlist_cache.pop(key, None)

    task = playlist_inflight.get(key)
    if task is None:
        task = asyncio.create_task(_load_and_cache_playlist(key, url, referer, origin))
        playlist_inflight[key] = task

        def clear_inflight(done: asyncio.Task, request_key=key) -> None:
            if playlist_inflight.get(request_key) is done:
                playlist_inflight.pop(request_key, None)

        task.add_done_callback(clear_inflight)

    return await asyncio.shield(task)


@app.get("/health")
async def health():
    return {
        "ok": bool(provider.channels),
        "channels": len(provider.channels),
        "mode": "ordered-sources",
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
async def stream(channel_id: str, source: int = Query(default=0, ge=0, le=20)):
    try:
        body = await provider.stream(channel_id, source)
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


@app.get("/hls/{path:path}")
async def hls(path: str):
    try:
        url, referer, origin = decode_target(path)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    if urlparse(url).path.lower().endswith(".m3u8"):
        try:
            body = await get_playlist(url, referer, origin)
        except UpstreamPlaylistError as exc:
            return JSONResponse(
                {"error": exc.message, "status": exc.status_code},
                status_code=exc.status_code,
            )
        return Response(
            content=body,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    try:
        response = await client.send(
            client.build_request(
                "GET",
                url,
                headers=provider.headers(referer, origin or None),
            ),
            stream=True,
        )
    except httpx.RequestError as exc:
        logger.warning("HLS request failed %s: %s", url, exc)
        return JSONResponse({"error": "upstream HLS unavailable"}, status_code=502)

    if response.status_code >= 400:
        status_code = response.status_code
        await response.aclose()
        return JSONResponse(
            {"error": "upstream HLS error", "status": status_code},
            status_code=status_code,
        )

    effective_url = str(response.url)
    content_type = response.headers.get("content-type", "application/octet-stream")
    is_playlist = "mpegurl" in content_type.lower()

    if is_playlist:
        try:
            body = (await response.aread()).decode("utf-8", errors="replace")
        except httpx.RequestError as exc:
            await response.aclose()
            logger.warning("HLS playlist body read failed %s: %s", effective_url, exc)
            return JSONResponse({"error": "upstream HLS playlist read failed"}, status_code=502)
        await response.aclose()
        if not body.lstrip().startswith("#EXTM3U"):
            return JSONResponse({"error": "invalid upstream HLS playlist"}, status_code=502)
        return Response(
            content=rewrite_hls_playlist(body, effective_url, referer),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    return StreamingResponse(
        response.aiter_bytes(chunk_size=64 * 1024),
        media_type=content_type,
        background=BackgroundTask(response.aclose),
    )
