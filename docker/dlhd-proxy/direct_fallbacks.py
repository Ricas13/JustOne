import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from hls_resilience import prepare_hls_playlist
from provider import rewrite_hls_playlist

logger = logging.getLogger(__name__)

FALLBACKS_PATH = Path("/app/data/direct-fallbacks.json")
MAX_SOURCES_PER_CHANNEL = 8


class NoDirectFallbackError(ValueError):
    """No configured direct HLS fallback exists for this channel."""


@dataclass(frozen=True)
class DirectFallbackSource:
    url: str
    referer: str = ""
    origin: str = ""


def _http_url(value: object) -> str:
    text = str(value or "").strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return text


class DirectFallbacks:
    """Load and resolve operator-supplied direct HLS fallbacks.

    The JSON file is intentionally data-only. JustOne does not derive signed URLs
    or credentials here; it simply proxies explicitly configured HLS endpoints.
    """

    def __init__(self, provider, path: Path = FALLBACKS_PATH) -> None:
        self.provider = provider
        self.path = path
        self._stamp: tuple[int, int] | None = None
        self._sources: dict[str, list[DirectFallbackSource]] = {}
        self._inflight: dict[str, asyncio.Task] = {}

    def _read_stamp(self) -> tuple[int, int] | None:
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def _reload_if_changed(self, force: bool = False) -> None:
        stamp = self._read_stamp()
        if not force and stamp == self._stamp:
            return

        self._stamp = stamp
        if stamp is None:
            self._sources = {}
            return

        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Direct fallback config ignored: %s", exc)
            self._sources = {}
            return

        if not isinstance(payload, dict):
            logger.warning("Direct fallback config must be a JSON object")
            self._sources = {}
            return

        parsed: dict[str, list[DirectFallbackSource]] = {}
        for raw_channel, raw_sources in payload.items():
            channel_id = str(raw_channel).strip()
            if not channel_id:
                continue
            rows = raw_sources if isinstance(raw_sources, list) else [raw_sources]
            sources: list[DirectFallbackSource] = []
            for raw in rows[:MAX_SOURCES_PER_CHANNEL]:
                if isinstance(raw, str):
                    url = _http_url(raw)
                    referer = ""
                    origin = ""
                elif isinstance(raw, dict):
                    url = _http_url(raw.get("url"))
                    referer = _http_url(raw.get("referer"))
                    origin = _http_url(raw.get("origin"))
                else:
                    continue
                if not url:
                    continue
                sources.append(DirectFallbackSource(url=url, referer=referer, origin=origin))
            if sources:
                parsed[channel_id] = sources

        self._sources = parsed
        logger.info(
            "Loaded direct HLS fallbacks for %s channel(s) from %s",
            len(parsed),
            self.path,
        )

    def summary(self) -> dict:
        self._reload_if_changed()
        return {
            "path": str(self.path),
            "configured_channels": len(self._sources),
            "configured_sources": sum(len(rows) for rows in self._sources.values()),
        }

    def has_channel(self, channel_id: str) -> bool:
        self._reload_if_changed()
        return str(channel_id) in self._sources

    async def _proxy_source(self, source: DirectFallbackSource, label: str) -> str:
        referer = source.referer or source.url
        headers = self.provider.headers(referer, source.origin or None)
        response = await self.provider._get_hls_with_retry(
            source.url,
            headers=headers,
            timeout=12,
        )
        if response.status_code >= 400:
            raise ValueError(f"{label} playlist HTTP {response.status_code}")
        if not response.text.lstrip().startswith("#EXTM3U"):
            raise ValueError(f"{label} returned invalid HLS")

        prepared = prepare_hls_playlist(response.text)
        return rewrite_hls_playlist(
            prepared,
            str(response.url),
            referer,
        )

    async def _resolve(self, channel_id: str) -> str:
        self._reload_if_changed()
        sources = self._sources.get(str(channel_id), [])
        if not sources:
            raise NoDirectFallbackError(f"No direct fallback configured for channel {channel_id}")

        failures: list[str] = []
        for index, source in enumerate(sources, start=1):
            label = f"fallback {index}"
            try:
                payload = await self._proxy_source(source, label)
                logger.info("Channel %s selected direct fallback %s/%s", channel_id, index, len(sources))
                return payload
            except Exception as exc:
                failures.append(f"{label}: {exc}")

        detail = "; ".join(failures[-4:]) or "all configured fallbacks failed"
        raise ValueError(f"Direct fallback unavailable for channel {channel_id}: {detail}")

    async def stream(self, channel_id: str, refresh: bool = False) -> str:
        channel_id = str(channel_id)
        if refresh:
            self._reload_if_changed(force=True)

        task = self._inflight.get(channel_id)
        if task is None:
            task = asyncio.create_task(self._resolve(channel_id))
            self._inflight[channel_id] = task

            def clear(done: asyncio.Task, key=channel_id) -> None:
                if self._inflight.get(key) is done:
                    self._inflight.pop(key, None)

            task.add_done_callback(clear)

        return await asyncio.shield(task)
