import asyncio
import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx

from settings import settings

logger = logging.getLogger(__name__)

RETRYABLE_STATUS_CODES = {408, 425, 500, 502, 503, 504}
NON_RETRYABLE_REFRESH_STATUS_CODES = {400, 401, 403, 404, 410, 429}


class UpstreamObjectError(Exception):
    def __init__(self, status_code: int, message: str, retry_after: str | None = None):
        super().__init__(message)
        self.status_code = int(status_code)
        self.message = message
        self.retry_after = retry_after


@dataclass(frozen=True)
class CacheKey:
    url: str
    referer: str
    origin: str


@dataclass
class FetchedObject:
    body: bytes
    content_type: str
    effective_url: str
    status_code: int = 200


@dataclass
class CacheEntry:
    fetched: FetchedObject
    expires_at: float


@dataclass
class PlaylistState:
    segments: list[str]
    headers: dict[str, str]
    positions: dict[str, int] = field(default_factory=dict)
    last_access: float = field(default_factory=time.monotonic)


_AUDIO_MEDIA_RE = re.compile(r"^#EXT-X-MEDIA:(.*)$", re.IGNORECASE)
_ATTR_RE = re.compile(r'(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))', re.IGNORECASE)


def _parse_attrs(value: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in _ATTR_RE.finditer(value):
        attrs[match.group(1).upper()] = match.group(2) if match.group(2) is not None else match.group(3)
    return attrs


def prune_audio_renditions(payload: str) -> str:
    """Keep only the first advertised audio rendition in each HLS audio group."""
    lines = payload.splitlines()
    first_by_group: dict[str, int] = {}
    remove: set[int] = set()

    for index, line in enumerate(lines):
        match = _AUDIO_MEDIA_RE.match(line.strip())
        if not match:
            continue
        attrs = _parse_attrs(match.group(1))
        if attrs.get("TYPE", "").upper() != "AUDIO":
            continue
        group = attrs.get("GROUP-ID", "__default__")
        if group in first_by_group:
            remove.add(index)
        else:
            first_by_group[group] = index

    if not remove:
        return payload if payload.endswith("\n") else payload + "\n"

    kept = [line for index, line in enumerate(lines) if index not in remove]
    return "\n".join(kept) + "\n"


def inject_live_start_offset(payload: str, seconds: float) -> str:
    if seconds <= 0:
        return payload if payload.endswith("\n") else payload + "\n"

    upper = payload.upper()
    if "#EXT-X-STREAM-INF" in upper:
        return payload if payload.endswith("\n") else payload + "\n"
    if "#EXT-X-ENDLIST" in upper or "#EXT-X-PLAYLIST-TYPE:VOD" in upper:
        return payload if payload.endswith("\n") else payload + "\n"
    if "#EXT-X-START:" in upper:
        return payload if payload.endswith("\n") else payload + "\n"

    lines = payload.splitlines()
    for index, line in enumerate(lines):
        if line.strip().upper() == "#EXTM3U":
            lines.insert(index + 1, f"#EXT-X-START:TIME-OFFSET=-{seconds:g},PRECISE=YES")
            break
    return "\n".join(lines) + "\n"


def prepare_hls_playlist(payload: str, live_start_offset_seconds: float | None = None) -> str:
    prepared = prune_audio_renditions(payload)
    offset = settings.hls_live_start_offset_seconds if live_start_offset_seconds is None else live_start_offset_seconds
    return inject_live_start_offset(prepared, offset)


def extract_media_segment_urls(payload: str, playlist_url: str) -> list[str]:
    if "#EXT-X-STREAM-INF" in payload.upper():
        return []

    out: list[str] = []
    expect_segment = False
    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.upper().startswith("#EXTINF:"):
            expect_segment = True
            continue
        if line.startswith("#"):
            continue
        if expect_segment:
            out.append(urljoin(playlist_url, line))
            expect_segment = False
    return out


class HLSResilience:
    """Bounded HLS object cache, single-flight downloader and segment prefetcher."""

    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.cache: OrderedDict[CacheKey, CacheEntry] = OrderedDict()
        self.cache_bytes = 0
        self.inflight: dict[CacheKey, asyncio.Task] = {}
        self.playlists: dict[str, PlaylistState] = {}
        self.segment_to_playlist: dict[str, str] = {}
        self.prefetch_tasks: dict[str, asyncio.Task] = {}
        self.background_tasks: set[asyncio.Task] = set()

    @staticmethod
    def _cache_key(url: str, headers: dict[str, str]) -> CacheKey:
        return CacheKey(
            url=url,
            referer=headers.get("Referer", ""),
            origin=headers.get("Origin", ""),
        )

    def _cache_get(self, key: CacheKey) -> FetchedObject | None:
        entry = self.cache.get(key)
        if entry is None:
            return None
        if entry.expires_at <= time.monotonic():
            self.cache.pop(key, None)
            self.cache_bytes -= len(entry.fetched.body)
            return None
        self.cache.move_to_end(key)
        return entry.fetched

    def _cache_put(self, key: CacheKey, fetched: FetchedObject) -> None:
        max_bytes = settings.hls_segment_cache_max_mb * 1024 * 1024
        if len(fetched.body) > max_bytes:
            return

        old = self.cache.pop(key, None)
        if old:
            self.cache_bytes -= len(old.fetched.body)

        self.cache[key] = CacheEntry(
            fetched=fetched,
            expires_at=time.monotonic() + settings.hls_segment_cache_ttl_seconds,
        )
        self.cache_bytes += len(fetched.body)
        self.cache.move_to_end(key)

        while self.cache and (
            len(self.cache) > settings.hls_segment_cache_items
            or self.cache_bytes > max_bytes
        ):
            _old_key, old_entry = self.cache.popitem(last=False)
            self.cache_bytes -= len(old_entry.fetched.body)

    @staticmethod
    def _response_retry_after(response: httpx.Response) -> str | None:
        value = response.headers.get("retry-after")
        return value.strip() if value else None

    async def _fetch_object(
        self,
        url: str,
        headers: dict[str, str],
        attempts: int,
        purpose: str,
    ) -> FetchedObject:
        last_error: UpstreamObjectError | None = None

        for attempt in range(attempts):
            try:
                response = await self.client.get(
                    url,
                    headers=headers,
                    timeout=httpx.Timeout(settings.hls_upstream_timeout_seconds),
                )
            except httpx.RequestError as exc:
                last_error = UpstreamObjectError(502, f"{purpose} request failed: {exc}")
                retryable = True
            else:
                status = response.status_code
                if status < 400:
                    body = response.content
                    content_length = response.headers.get("content-length")
                    content_encoding = response.headers.get("content-encoding")
                    if content_length and not content_encoding:
                        try:
                            expected = int(content_length)
                        except ValueError:
                            expected = -1
                        if expected >= 0 and expected != len(body):
                            last_error = UpstreamObjectError(
                                502,
                                f"{purpose} truncated: expected {expected} bytes, got {len(body)}",
                            )
                            retryable = True
                        else:
                            return FetchedObject(
                                body=body,
                                content_type=response.headers.get("content-type", "application/octet-stream"),
                                effective_url=str(response.url),
                                status_code=status,
                            )
                    else:
                        return FetchedObject(
                            body=body,
                            content_type=response.headers.get("content-type", "application/octet-stream"),
                            effective_url=str(response.url),
                            status_code=status,
                        )
                else:
                    retry_after = self._response_retry_after(response)
                    last_error = UpstreamObjectError(
                        status,
                        f"{purpose} upstream HTTP {status}",
                        retry_after=retry_after,
                    )
                    retryable = status in RETRYABLE_STATUS_CODES
                    if status in NON_RETRYABLE_REFRESH_STATUS_CODES:
                        retryable = False

            if not retryable or attempt >= attempts - 1:
                assert last_error is not None
                raise last_error

            delay = settings.hls_retry_base_seconds * (2 ** attempt)
            logger.warning(
                "%s transient failure for %s; retry %s/%s in %.2fs: %s",
                purpose,
                url,
                attempt + 2,
                attempts,
                delay,
                last_error,
            )
            await asyncio.sleep(delay)

        assert last_error is not None
        raise last_error

    async def fetch_playlist(self, url: str, headers: dict[str, str]) -> FetchedObject:
        return await self._fetch_object(
            url,
            headers,
            attempts=settings.hls_playlist_retry_attempts,
            purpose="HLS playlist",
        )

    async def _fetch_and_cache_segment(
        self,
        key: CacheKey,
        url: str,
        headers: dict[str, str],
    ) -> FetchedObject:
        fetched = await self._fetch_object(
            url,
            headers,
            attempts=settings.hls_segment_retry_attempts,
            purpose="HLS object",
        )
        self._cache_put(key, fetched)
        return fetched

    async def _get_segment(
        self,
        url: str,
        headers: dict[str, str],
        *,
        schedule_prefetch: bool,
    ) -> FetchedObject:
        key = self._cache_key(url, headers)
        cached = self._cache_get(key)
        if cached is not None:
            if schedule_prefetch:
                self._schedule_prefetch(url)
            return cached

        task = self.inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_and_cache_segment(key, url, headers))
            self.inflight[key] = task

            def clear(done: asyncio.Task, request_key: CacheKey = key) -> None:
                if self.inflight.get(request_key) is done:
                    self.inflight.pop(request_key, None)

            task.add_done_callback(clear)

        fetched = await asyncio.shield(task)
        if schedule_prefetch:
            self._schedule_prefetch(url)
        return fetched

    async def fetch_segment(self, url: str, headers: dict[str, str]) -> FetchedObject:
        return await self._get_segment(url, headers, schedule_prefetch=True)

    def _cleanup_playlists(self) -> None:
        cutoff = time.monotonic() - settings.hls_playlist_inactivity_seconds
        stale = [key for key, state in self.playlists.items() if state.last_access < cutoff]
        for playlist_url in stale:
            state = self.playlists.pop(playlist_url, None)
            if not state:
                continue
            for segment in state.segments:
                if self.segment_to_playlist.get(segment) == playlist_url:
                    self.segment_to_playlist.pop(segment, None)
            task = self.prefetch_tasks.pop(playlist_url, None)
            if task and not task.done():
                task.cancel()

    def register_playlist(
        self,
        playlist_url: str,
        segment_urls: list[str],
        headers: dict[str, str],
    ) -> None:
        if not segment_urls:
            return

        self._cleanup_playlists()
        previous = self.playlists.get(playlist_url)
        if previous:
            for segment in previous.segments:
                if segment not in segment_urls and self.segment_to_playlist.get(segment) == playlist_url:
                    self.segment_to_playlist.pop(segment, None)

        state = PlaylistState(
            segments=list(segment_urls),
            headers=dict(headers),
            positions={url: index for index, url in enumerate(segment_urls)},
            last_access=time.monotonic(),
        )
        self.playlists[playlist_url] = state
        for segment in segment_urls:
            self.segment_to_playlist[segment] = playlist_url

    def _schedule_prefetch(self, current_segment: str) -> None:
        if settings.hls_prefetch_segments <= 0:
            return
        playlist_url = self.segment_to_playlist.get(current_segment)
        if not playlist_url:
            return
        state = self.playlists.get(playlist_url)
        if not state:
            return
        index = state.positions.get(current_segment)
        if index is None:
            return
        state.last_access = time.monotonic()

        existing = self.prefetch_tasks.get(playlist_url)
        if existing and not existing.done():
            return

        end = min(len(state.segments), index + 1 + settings.hls_prefetch_segments)
        upcoming = state.segments[index + 1:end]
        if not upcoming:
            return

        task = asyncio.create_task(self._prefetch_sequence(playlist_url, upcoming, state.headers))
        self.prefetch_tasks[playlist_url] = task
        self.background_tasks.add(task)

        def done_callback(done: asyncio.Task, key: str = playlist_url) -> None:
            self.background_tasks.discard(done)
            if self.prefetch_tasks.get(key) is done:
                self.prefetch_tasks.pop(key, None)

        task.add_done_callback(done_callback)

    async def _prefetch_sequence(
        self,
        playlist_url: str,
        segment_urls: list[str],
        headers: dict[str, str],
    ) -> None:
        for url in segment_urls:
            try:
                await self._get_segment(url, headers, schedule_prefetch=False)
            except asyncio.CancelledError:
                raise
            except UpstreamObjectError as exc:
                logger.warning(
                    "HLS prefetch stopped for %s after upstream %s on %s",
                    playlist_url,
                    exc.status_code,
                    url,
                )
                return
            except Exception as exc:
                logger.warning("HLS prefetch stopped for %s: %s", playlist_url, exc)
                return

    def stats(self) -> dict[str, int]:
        return {
            "cache_entries": len(self.cache),
            "cache_bytes": max(0, self.cache_bytes),
            "inflight": len(self.inflight),
            "playlists": len(self.playlists),
            "prefetchers": sum(1 for task in self.prefetch_tasks.values() if not task.done()),
        }

    async def close(self) -> None:
        tasks = list(self.background_tasks) + list(self.inflight.values())
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.background_tasks.clear()
        self.inflight.clear()
        self.prefetch_tasks.clear()
        self.playlists.clear()
        self.segment_to_playlist.clear()
        self.cache.clear()
        self.cache_bytes = 0
