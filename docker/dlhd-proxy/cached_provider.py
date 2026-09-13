import asyncio
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

from provider import Provider, extract_direct_hls_sources, logger
from settings import settings

SOURCE_DISCOVERY_TTL_SECONDS = 20
# These slots mirror the current Player 1..7 buttons on /watch.php in site order.
# Keep slot numbers stable even when an individual player is unsupported or down;
# Jellyfin failover must still be able to reach later provider players.
PLAYER_FOLDERS = ("stream", "cast", "watch", "plus", "casting", "player", "hub")
MAX_IFRAME_DEPTH = 3
MAX_PLAYER_PAGES_PER_SLOT = 8


class NoMoreSourcesError(ValueError):
    """The requested source index is beyond the provider's known player slots."""


@dataclass
class SourceCandidate:
    kind: str
    label: str
    player_url: str
    player_text: str = ""
    direct_url: str = ""


@dataclass
class SlotDiscovery:
    candidates: list[SourceCandidate] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


@dataclass
class DiscoveryState:
    expires_at: float
    slots: dict[int, SlotDiscovery] = field(default_factory=dict)


class CachedProvider(Provider):
    """Cache provider discovery while preserving the website's Player 1..7 slots."""

    def __init__(self) -> None:
        super().__init__()
        self._source_cache: dict[str, DiscoveryState] = {}
        self._source_locks: dict[str, asyncio.Lock] = {}

    def invalidate(self, channel_id: str) -> None:
        if self._source_cache.pop(str(channel_id), None) is not None:
            logger.info("Channel %s source discovery explicitly invalidated", channel_id)

    def _fresh_state(self) -> DiscoveryState:
        return DiscoveryState(
            expires_at=time.monotonic() + SOURCE_DISCOVERY_TTL_SECONDS,
        )

    @staticmethod
    def _iframe_urls(response_url: str, response_text: str) -> list[str]:
        out: list[str] = []
        for value in re.findall(
            r'<iframe[^>]+src=["\']([^"\']+)["\']',
            response_text,
            re.IGNORECASE,
        ):
            candidate = urljoin(response_url, value)
            if candidate not in out:
                out.append(candidate)
        return out

    async def _discover_slot(self, channel_id: str, source_index: int) -> SlotDiscovery:
        folder = PLAYER_FOLDERS[source_index]
        page_url = f"{settings.base_url}/{folder}/stream-{channel_id}.php"
        slot = SlotDiscovery()
        visited: set[str] = set()
        seen_sources: set[str] = set()

        async def visit(
            url: str,
            *,
            referer: str | None,
            label: str,
            depth: int,
            response=None,
        ) -> None:
            if url in visited:
                return
            if len(visited) >= MAX_PLAYER_PAGES_PER_SLOT:
                slot.failures.append(f"{label}: player page limit reached")
                return
            visited.add(url)

            try:
                player = response or await self._get(
                    url,
                    headers=self.headers(referer),
                    timeout=settings.source_request_timeout_seconds,
                )
            except Exception as exc:
                slot.failures.append(f"{label}: player {type(exc).__name__}")
                return

            if player.status_code >= 400:
                slot.failures.append(f"{label}: player HTTP {player.status_code}")
                return

            effective_url = str(getattr(player, "url", None) or url)
            player_text = player.text
            found_here = False

            legacy_keys = re.findall(r'const\s+CHANNEL_KEY\s*=\s*"(.*?)";', player_text)
            if legacy_keys:
                source_key = f"legacy:{legacy_keys[-1]}"
                if source_key not in seen_sources:
                    seen_sources.add(source_key)
                    slot.candidates.append(SourceCandidate(
                        kind="legacy",
                        label=label,
                        player_url=effective_url,
                        player_text=player_text,
                    ))
                    found_here = True

            direct_sources = extract_direct_hls_sources(player_text)
            for direct_index, direct_url in enumerate(direct_sources):
                source_key = f"direct:{direct_url}"
                if source_key in seen_sources:
                    continue
                seen_sources.add(source_key)
                direct_label = (
                    f"{label}/source#{direct_index + 1}"
                    if len(direct_sources) > 1
                    else label
                )
                slot.candidates.append(SourceCandidate(
                    kind="direct",
                    label=direct_label,
                    player_url=effective_url,
                    direct_url=direct_url,
                ))
                found_here = True

            iframe_urls = self._iframe_urls(effective_url, player_text)
            if iframe_urls and depth < MAX_IFRAME_DEPTH:
                for iframe_index, iframe_url in enumerate(iframe_urls, start=1):
                    await visit(
                        iframe_url,
                        referer=effective_url,
                        label=f"{label}>iframe#{iframe_index}",
                        depth=depth + 1,
                    )
            elif iframe_urls:
                slot.failures.append(f"{label}: iframe depth limit reached")
            elif not found_here:
                if "window._econfig" in player_text:
                    slot.failures.append(f"{label}: dynamic player unsupported")
                else:
                    slot.failures.append(f"{label}: unsupported player")

        try:
            page = await self._get(
                page_url,
                headers=self.headers(),
                timeout=settings.source_request_timeout_seconds,
            )
        except Exception as exc:
            slot.failures.append(f"{folder}: page {type(exc).__name__}")
            return slot

        if page.status_code >= 400:
            slot.failures.append(f"{folder}: page HTTP {page.status_code}")
            return slot

        await visit(
            page_url,
            referer=settings.base_url,
            label=folder,
            depth=0,
            response=page,
        )
        return slot

    async def _ensure_slot(self, channel_id: str, source_index: int) -> SlotDiscovery:
        if source_index >= len(PLAYER_FOLDERS):
            raise NoMoreSourcesError(
                f"Source {source_index + 1} does not exist "
                f"(provider exposes {len(PLAYER_FOLDERS)} player slots)"
            )

        channel_id = str(channel_id)
        lock = self._source_locks.setdefault(channel_id, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            state = self._source_cache.get(channel_id)
            if state is None or state.expires_at <= now:
                state = self._fresh_state()
                self._source_cache[channel_id] = state

            slot = state.slots.get(source_index)
            if slot is None:
                slot = await self._discover_slot(channel_id, source_index)
                state.slots[source_index] = slot

            logger.info(
                "Channel %s source slot %s/%s (%s) discovered %s candidate(s)",
                channel_id,
                source_index + 1,
                len(PLAYER_FOLDERS),
                PLAYER_FOLDERS[source_index],
                len(slot.candidates),
            )
            return slot

    async def stream(self, channel_id: str, source_index: int = 0) -> str:
        if source_index < 0:
            raise ValueError("source must be >= 0")

        slot = await self._ensure_slot(channel_id, source_index)
        folder = PLAYER_FOLDERS[source_index]
        if not slot.candidates:
            detail = "; ".join(slot.failures[-12:]) or "no supported player candidate"
            raise ValueError(
                f"Source {source_index + 1} via {folder} unavailable: {detail}"
            )

        runtime_failures: list[str] = []
        for selected in slot.candidates:
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
                runtime_failures.append(f"{selected.label}: {exc}")
                continue

            logger.info(
                "Channel %s selected source slot %s/%s via %s (%s)",
                channel_id,
                source_index + 1,
                len(PLAYER_FOLDERS),
                selected.label,
                mode,
            )
            return payload

        detail_parts = slot.failures[-8:] + runtime_failures[-4:]
        detail = "; ".join(detail_parts) or "all candidates failed"
        raise ValueError(
            f"Source {source_index + 1} via {folder} unavailable: {detail}"
        )
