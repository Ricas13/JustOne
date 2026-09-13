import html
import logging
import re
from dataclasses import dataclass

from curl_cffi import AsyncSession

from settings import settings

logger = logging.getLogger(__name__)


@dataclass
class Channel:
    id: str
    name: str


def parse_channels(payload: str) -> list[Channel]:
    """Parse the provider's 24/7 catalogue without resolving any media."""
    matches = re.findall(
        r'href=["\']/watch\.php\?id=(\d+)["\'][^>]*>[\s\S]*?'
        r'<div[^>]*class=["\'][^"\']*card__title[^"\']*["\'][^>]*>(.*?)</div>',
        str(payload or ""),
        re.IGNORECASE,
    )

    seen: set[str] = set()
    channels: list[Channel] = []
    for channel_id, raw_name in matches:
        if channel_id in seen:
            continue
        seen.add(channel_id)
        name = re.sub(r"<[^>]+>", " ", raw_name)
        name = html.unescape(name).replace("#", "")
        name = re.sub(r"\s+", " ", name).strip()
        if not name:
            continue
        channels.append(Channel(id=channel_id, name=name))
    return channels


class Provider:
    """Catalogue-only DLHD client.

    Playback deliberately does not live here. The returned channel URLs are
    handed to EasyProxy, which owns extraction, authentication and HLS proxying.
    """

    def __init__(self) -> None:
        self._session = AsyncSession(
            proxy=f"socks5://{settings.socks5}" if settings.socks5 else None,
        )
        self.channels: list[Channel] = []

    def headers(self) -> dict[str, str]:
        return {
            "Referer": f"{settings.base_url}/",
            "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        }

    async def load_channels(self) -> None:
        url = f"{settings.base_url}/24-7-channels.php"
        response = await self._session.get(url, headers=self.headers(), timeout=20)
        if response.status_code >= 400:
            raise ValueError(f"Channel list HTTP {response.status_code}")

        channels = parse_channels(response.text)
        if not channels:
            raise ValueError("Channel list contained no supported rows")

        # Duplicate names intentionally remain separate. The Jellyfin metadata
        # layer is the single place that merges provider rows into logical TV
        # channels while retaining ordered candidates.
        self.channels = channels
        logger.info("Loaded %d raw DLHD catalogue channels", len(channels))

    def playback_url(self, channel: Channel) -> str:
        return f"{settings.playback_base_url}/watch.php?id={channel.id}"

    async def close(self) -> None:
        await self._session.close()
