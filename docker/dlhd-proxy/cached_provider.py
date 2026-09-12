import asyncio
import re
import time
from dataclasses import dataclass
from urllib.parse import urljoin

from provider import PLAYER_FOLDERS, Provider, extract_direct_hls_sources, logger
from settings import settings

SOURCE_DISCOVERY_TTL_SECONDS = 20
MAX_DISCOVERED_SOURCES = 6


@dataclass
class SourceCandidate:
    kind: str
    label: str
    player_url: str
    player_text: str = ""
    direct_url: str = ""


class CachedProvider(Provider):
    """Discover ordered provider alternatives once, then reuse them briefly.

    The old Provider.stream() rescans every player family for each source=N
    request. Jellyfin's ordered failover can issue source=0..5 in quick
    succession, which multiplied provider page/player requests. This wrapper
    separates cheap source discovery from per-source HLS validation and caches
    only the discovered descriptors for a short TTL. HLS playlists themselves
    are never cached here.
    """

    def __init__(self) -> None:
        super().__init__()
        self._source_cache: dict[str, tuple[float, list[SourceCandidate], list[str]]] = {}
        self._source_locks: dict[str, asyncio.Lock] = {}

    async def _discover_sources(self, channel_id: str) -> tuple[list[SourceCandidate], list[str]]:
        candidates: list[SourceCandidate] = []
        seen_sources: set[str] = set()
        failures: list[str] = []

        for folder in PLAYER_FOLDERS:
            if len(candidates) >= MAX_DISCOVERED_SOURCES:
                break

            page_url = f"{settings.base_url}/{folder}/stream-{channel_id}.php"
            try:
                page = await self._get(page_url, headers=self.headers(), timeout=12)
            except Exception as exc:
                failures.append(f"{folder}: page {type(exc).__name__}")
                continue

            if page.status_code >= 400:
                failures.append(f"{folder}: page HTTP {page.status_code}")
                continue

            iframe_paths = re.findall(
                r'<iframe[^>]+src=["\']([^"\']+)["\']',
                page.text,
                re.IGNORECASE,
            )
            player_urls: list[str] = []
            for value in iframe_paths:
                candidate = urljoin(page_url, value)
                if candidate not in player_urls:
                    player_urls.append(candidate)

            if not player_urls:
                player_urls = [page_url]

            for embed_index, player_url in enumerate(player_urls):
                if len(candidates) >= MAX_DISCOVERED_SOURCES:
                    break

                label = f"{folder}#{embed_index + 1}" if len(player_urls) > 1 else folder
                try:
                    player = page if player_url == page_url else await self._get(
                        player_url,
                        headers=self.headers(page_url),
                        timeout=12,
                    )
                except Exception as exc:
                    failures.append(f"{label}: player {type(exc).__name__}")
                    continue

                if player.status_code >= 400:
                    failures.append(f"{label}: player HTTP {player.status_code}")
                    continue

                legacy_keys = re.findall(r'const\s+CHANNEL_KEY\s*=\s*"(.*?)";', player.text)
                if legacy_keys:
                    source_key = f"legacy:{legacy_keys[-1]}"
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)
                    candidates.append(SourceCandidate(
                        kind="legacy",
                        label=label,
                        player_url=player_url,
                        player_text=player.text,
                    ))
                    continue

                direct_sources = extract_direct_hls_sources(player.text)
                if not direct_sources:
                    failures.append(f"{label}: unsupported player")
                    continue

                for direct_index, direct_url in enumerate(direct_sources):
                    if len(candidates) >= MAX_DISCOVERED_SOURCES:
                        break

                    source_key = f"direct:{direct_url}"
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)
                    direct_label = (
                        f"{label}/source#{direct_index + 1}"
                        if len(direct_sources) > 1
                        else label
                    )
                    candidates.append(SourceCandidate(
                        kind="direct",
                        label=direct_label,
                        player_url=player_url,
                        direct_url=direct_url,
                    ))

        return candidates, failures

    async def _cached_sources(self, channel_id: str) -> tuple[list[SourceCandidate], list[str]]:
        now = time.monotonic()
        cached = self._source_cache.get(channel_id)
        if cached and cached[0] > now:
            return cached[1], cached[2]

        lock = self._source_locks.setdefault(channel_id, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            cached = self._source_cache.get(channel_id)
            if cached and cached[0] > now:
                return cached[1], cached[2]

            candidates, failures = await self._discover_sources(channel_id)
            self._source_cache[channel_id] = (
                time.monotonic() + SOURCE_DISCOVERY_TTL_SECONDS,
                candidates,
                failures,
            )
            logger.info(
                "Channel %s discovered %s ordered source option(s); cache=%ss",
                channel_id,
                len(candidates),
                SOURCE_DISCOVERY_TTL_SECONDS,
            )
            return candidates, failures

    async def stream(self, channel_id: str, source_index: int = 0) -> str:
        if source_index < 0:
            raise ValueError("source must be >= 0")

        candidates, failures = await self._cached_sources(channel_id)
        if source_index >= len(candidates):
            detail = "; ".join(failures[-12:]) or "no provider player candidates"
            raise ValueError(
                f"Source {source_index + 1} does not exist or is unavailable "
                f"({len(candidates)} discovered; {detail})"
            )

        selected = candidates[source_index]
        try:
            if selected.kind == "legacy":
                payload = await self._legacy_stream(selected.player_url, selected.player_text)
                mode = "legacy authenticated"
            else:
                payload = await self._direct_stream(
                    selected.direct_url,
                    selected.player_url,
                    source_index + 1,
                )
                mode = "direct HLS"
        except Exception as exc:
            raise ValueError(
                f"Source {source_index + 1} via {selected.label} unavailable: {exc}"
            ) from exc

        logger.info(
            "Channel %s selected source %s via %s (%s)",
            channel_id,
            source_index + 1,
            selected.label,
            mode,
        )
        return payload
