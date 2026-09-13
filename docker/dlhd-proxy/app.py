import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.responses import Response

from provider import Provider
from settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("justone.catalogue")

provider = Provider()
refresh_task: asyncio.Task | None = None


async def refresh_channels_forever() -> None:
    while True:
        try:
            await asyncio.sleep(settings.refresh_seconds)
            await provider.load_channels()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Channel catalogue refresh failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global refresh_task
    try:
        await provider.load_channels()
    except Exception:
        logger.exception("Initial channel catalogue load failed")
    refresh_task = asyncio.create_task(refresh_channels_forever())
    try:
        yield
    finally:
        if refresh_task:
            refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await refresh_task
        await provider.close()


app = FastAPI(title="JustOne DLHD Catalogue", lifespan=lifespan)


def m3u_escape(value: str) -> str:
    return str(value or "").replace('"', "'").replace("\r", " ").replace("\n", " ").strip()


@app.get("/health")
async def health():
    return {
        "ok": bool(provider.channels),
        "channels": len(provider.channels),
        "mode": "catalogue-only",
        "playback": "easyproxy",
    }


@app.get("/channels")
async def channels():
    return [
        {
            "id": channel.id,
            "name": channel.name,
            "url": provider.playback_url(channel),
        }
        for channel in provider.channels
    ]


@app.get("/playlist.m3u8")
async def playlist():
    lines = ["#EXTM3U"]
    for channel in provider.channels:
        name = m3u_escape(channel.name)
        lines.append(
            f'#EXTINF:-1 tvg-id="dlhd-{channel.id}" tvg-name="{name}" group-title="DLHD",{name}'
        )
        # This is deliberately the provider page, not a JustOne stream URL.
        # EasyProxy receives this URL at tune time and owns all media handling.
        lines.append(provider.playback_url(channel))
    return Response(
        content="\n".join(lines) + "\n",
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache"},
    )
