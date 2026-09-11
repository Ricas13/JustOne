import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from provider import Provider, decode_target, rewrite_hls_playlist
from settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("justone.dlhd")

provider = Provider()
client = httpx.AsyncClient(
    http2=True,
    timeout=httpx.Timeout(15.0, read=60.0),
    follow_redirects=True,
    verify=False,
)
refresh_task: asyncio.Task | None = None


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
        await client.aclose()
        await provider.close()


app = FastAPI(title="JustOne DLHD", lifespan=lifespan)


def m3u_escape(value: str) -> str:
    return str(value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


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
    is_playlist = (
        "mpegurl" in content_type.lower()
        or "m3u8" in content_type.lower()
        or urlparse(effective_url).path.lower().endswith(".m3u8")
    )

    if is_playlist:
        body = (await response.aread()).decode("utf-8", errors="replace")
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
