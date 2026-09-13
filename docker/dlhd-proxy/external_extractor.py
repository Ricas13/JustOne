import asyncio
import time
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

from settings import settings


@dataclass(frozen=True)
class ExternalResolvedStream:
    url: str
    extractor: str
    source_url: str


@dataclass
class _CacheEntry:
    expires_at: float
    value: ExternalResolvedStream


def parse_host_map(raw: str) -> dict[str, str]:
    """Parse host=Extractor pairs from a comma-separated environment value.

    Exact hostnames and wildcard suffixes such as ``*.example.com`` are
    supported. Invalid/empty entries are ignored so a bad optional setting
    cannot take down the normal resolver.
    """
    out: dict[str, str] = {}
    for item in str(raw or "").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        host, extractor = item.split("=", 1)
        host = host.strip().lower().rstrip(".")
        extractor = extractor.strip()
        if host and extractor:
            out[host] = extractor
    return out


class ExternalExtractorClient:
    """Small MediaFlow-compatible extraction adapter.

    The external service remains responsible for resolving the configured page
    into a player-friendly HLS URL. JustOne only accepts a redirect returned by
    the extractor endpoint and then runs that HLS through its existing proxy.
    This keeps provider-specific extraction logic outside the Jellyfin-facing
    resolver and makes the feature entirely opt-in.
    """

    def __init__(self, get) -> None:
        self._get = get
        self._cache: dict[tuple[str, str, str], _CacheEntry] = {}
        self._locks: dict[tuple[str, str, str], asyncio.Lock] = {}

    @property
    def enabled(self) -> bool:
        return bool(settings.external_extractor_url and settings.external_extractor_host_map)

    def extractor_for_url(self, url: str) -> str | None:
        if not self.enabled:
            return None
        try:
            hostname = (urlparse(url).hostname or "").lower().rstrip(".")
        except Exception:
            return None
        if not hostname:
            return None

        direct = settings.external_extractor_host_map.get(hostname)
        if direct:
            return direct

        for pattern, extractor in settings.external_extractor_host_map.items():
            if not pattern.startswith("*."):
                continue
            suffix = pattern[1:].lower()  # includes leading dot
            if hostname.endswith(suffix) and hostname != suffix[1:]:
                return extractor
        return None

    def invalidate(self, url: str, referer: str = "") -> None:
        extractor = self.extractor_for_url(url)
        if not extractor:
            return
        self._cache.pop((extractor, str(url), str(referer or "")), None)

    async def resolve(self, url: str, *, referer: str = "", force: bool = False) -> ExternalResolvedStream:
        extractor = self.extractor_for_url(url)
        if not extractor:
            raise ValueError("external extractor not configured for player host")

        key = (extractor, str(url), str(referer or ""))
        now = time.monotonic()
        if not force:
            hit = self._cache.get(key)
            if hit and hit.expires_at > now:
                return hit.value

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            if not force:
                hit = self._cache.get(key)
                if hit and hit.expires_at > now:
                    return hit.value

            endpoint = f"{settings.external_extractor_url}/extractor/video.m3u8"
            params = {
                "host": extractor,
                "d": str(url),
                "redirect_stream": "true",
            }
            if settings.external_extractor_api_password:
                params["api_password"] = settings.external_extractor_api_password
            if referer:
                params["h_referer"] = str(referer)
                parsed_referer = urlparse(str(referer))
                if parsed_referer.scheme and parsed_referer.netloc:
                    params["h_origin"] = f"{parsed_referer.scheme}://{parsed_referer.netloc}"
            params["h_user-agent"] = settings.external_extractor_user_agent

            response = await self._get(
                endpoint,
                params=params,
                headers={"Accept": "*/*", "User-Agent": settings.external_extractor_user_agent},
                timeout=settings.external_extractor_timeout_seconds,
                allow_redirects=False,
            )

            if response.status_code < 300 or response.status_code >= 400:
                detail = str(getattr(response, "text", ""))[:200].replace("\n", " ")
                raise ValueError(
                    f"external extractor {extractor} HTTP {response.status_code}"
                    + (f": {detail}" if detail else "")
                )

            location = response.headers.get("location") or response.headers.get("Location")
            if not location:
                raise ValueError(f"external extractor {extractor} returned no stream redirect")

            resolved_url = urljoin(str(getattr(response, "url", None) or endpoint), str(location))
            if not resolved_url.startswith(("http://", "https://")):
                raise ValueError(f"external extractor {extractor} returned invalid stream URL")

            value = ExternalResolvedStream(
                url=resolved_url,
                extractor=extractor,
                source_url=str(url),
            )
            self._cache[key] = _CacheEntry(
                expires_at=time.monotonic() + settings.external_extractor_cache_ttl_seconds,
                value=value,
            )
            return value
