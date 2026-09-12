import asyncio
import re
import time
from dataclasses import dataclass, field
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


@dataclass
class DiscoveryState:
    expires_at: float
    candidates: list[SourceCandidate] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    seen_sources: set[str] = field(default_factory=set)
    next_folder_index: int = 0

    @property
    def complete(self) -> bool:
        return (
            self.next_folder_index >= len(PLAYER_FOLDERS)
            or len(self.candidates) >= MAX_DISCOVERED_SOURCES
        )


class CachedProvider(Provider):
    """Progressively discover ordered provider alternatives and reuse them.

    Provider.stream() rescans player families from the beginning for every
    source=N request. Jellyfin can issue source=0..5 in quick succession when
    failing over, multiplying provider page/player traffic.

    This wrapper keeps a short per-channel discovery state. Source 1 scans only
    as far as needed to discover option 1. If that option fails, source 2
    continues from the next unscanned family instead of starting over. HLS
    playlists themselves are never cached here.
    """

    def __init__(self) -> None:
        super().__init__()
        self._source_cache: dict[str, DiscoveryState] = {}
        self._source_locks: dict[str, asyncio.Lock] = {}

    def _fresh_state(self) -> DiscoveryState:
        return DiscoveryState(
            expires_at=time.monotonic() + SOURCE_DISCOVERY_TTL_SECONDS,
        )

    async def _scan_next_folder(self, channel_id: str, state: DiscoveryState) -> None:
        if state.complete:
            return

        folder = PLAYER_FOLDERS[state.next_folder_index]
        state.next_folder_index += 1
        page_url = f"{settings.base_url}/{folder}/stream-{channel_id}.php"

        try:
            page = await self._get(page_url, headers=self.headers(), timeout=12)
        except Exception as exc:
            state.failures.append(f"{folder}: page {type(exc).__name__}")
            return

        if page.status_code >= 400:
            state.failures.append(f"{folder}: page HTTP {page.status_code}")
            return

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
            if len(state.candidates) >= MAX_DISCOVERED_SOURCES:
                break

            label = f"{folder}#{embed_index + 1}" if len(player_urls) > 1 else folder
            try:
                player = page if player_url == page_url else await self._get(
                    player_url,
                    headers=self.headers(page_url),
                    timeout=12,
                )
            except Exception as exc:
                state.failures.append(f"{label}: player {type(exc).__name__}")
                continue

            if player.status_code >= 400:
                state.failures.append(f"{label}: player HTTP {player.status_code}")
                continue

            legacy_keys = re.findall(r'const\s+CHANNEL_KEY\s*=\s*"(.*?)";', player.text)
            if legacy_keys:
                source_key = f"legacy:{legacy_keys[-1]}"
                if source_key in state.seen_sources:
                    continue
                state.seen_sources.add(source_key)
                state.candidates.append(SourceCandidate(
                    kind="legacy",
                    label=label,
                    player_url=player_url,
                    player_text=player.text,
                ))
                continue

            direct_sources = extract_direct_hls_sources(player.text)
            if not direct_sources:
                state.failures.append(f"{label}: unsupported player")
                continue

            for direct_index, direct_url in enumerate(direct_sources):
                if len(state.candidates) >= MAX_DISCOVERED_SOURCES:
                    break

                source_key = f"direct:{direct_url}"
                if source_key in state.seen_sources:
                    continue
                state.seen_sources.add(source_key)
                direct_label = (
                    f"{label}/source#{direct_index + 1}"
                    if len(direct_sources) > 1
                    else label
                )
                state.candidates.append(SourceCandidate(
                    kind="direct",
                    label=direct_label,
                    player_url=player_url,
                    direct_url=direct_url,
                ))

    async def _ensure_source(self, channel_id: str, source_index: int) -> DiscoveryState:
        lock = self._source_locks.setdefault(channel_id, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            state = self._source_cache.get(channel_id)
            if state is None or state.expires_at <= now:
                state = self._fresh_state()
                self._source_cache[channel_id] = state

            while len(state.candidates) <= source_index and not state.complete:
                await self._scan_next_folder(channel_id, state)

            logger.info(
                "Channel %s discovery has %s ordered source option(s), scanned %s/%s family/families",
                channel_id,
                len(state.candidates),
                state.next_folder_index,
                len(PLAYER_FOLDERS),
            )
            return state

    async def stream(self, channel_id: str, source_index: int = 0) -> str:
        if source_index < 0:
            raise ValueError("source must be >= 0")

        state = await self._ensure_source(channel_id, source_index)
        if source_index >= len(state.candidates):
            detail = "; ".join(state.failures[-12:]) or "no provider player candidates"
            raise ValueError(
                f"Source {source_index + 1} does not exist or is unavailable "
                f"({len(state.candidates)} discovered; {detail})"
            )

        selected = state.candidates[source_index]
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
