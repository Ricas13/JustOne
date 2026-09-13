import os


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _host_map_env(name: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in os.getenv(name, "").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        host, extractor = item.split("=", 1)
        host = host.strip().lower().rstrip(".")
        extractor = extractor.strip()
        if host and extractor:
            out[host] = extractor
    return out


class Settings:
    def __init__(self) -> None:
        self.base_url = os.getenv("DLHD_BASE_URL", "https://daddylivestream.com").rstrip("/")
        self.api_url = os.getenv("API_URL", "http://localhost:3000").rstrip("/")
        self.socks5 = os.getenv("SOCKS5", "").strip()
        self.refresh_seconds = max(60, int(os.getenv("CHANNEL_REFRESH_SECONDS", "300")))

        # Tune-time resolver work must finish before Jellyfin Live's FFmpeg input
        # timeout. Keep individual provider requests short and enforce a hard
        # end-to-end resolver deadline in app.py.
        self.source_request_timeout_seconds = _float_env("DLHD_SOURCE_REQUEST_TIMEOUT_SECONDS", 5.0, 1.0, 10.0)
        self.source_resolve_timeout_seconds = _float_env("DLHD_SOURCE_RESOLVE_TIMEOUT_SECONDS", 12.0, 3.0, 18.0)

        # Resolver retries are deliberately bounded. Jellyfin Live already
        # performs same-source re-resolution, so two tune-stage attempts are
        # enough to smooth a short 5xx burst without blocking startup.
        self.source_retry_attempts = _int_env("DLHD_SOURCE_RETRY_ATTEMPTS", 2, 1, 3)
        self.source_retry_base_seconds = _float_env("DLHD_SOURCE_RETRY_BASE_SECONDS", 0.5, 0.1, 5.0)

        # Optional external extractor. This is deliberately opt-in: JustOne only
        # delegates pages whose hostname is explicitly mapped by the operator.
        # Format: host=Extractor,*.example.org=OtherExtractor
        self.external_extractor_url = os.getenv("EXTERNAL_EXTRACTOR_URL", "").strip().rstrip("/")
        self.external_extractor_api_password = os.getenv("EXTERNAL_EXTRACTOR_API_PASSWORD", "").strip()
        self.external_extractor_host_map = _host_map_env("EXTERNAL_EXTRACTOR_HOST_MAP")
        self.external_extractor_timeout_seconds = _float_env("EXTERNAL_EXTRACTOR_TIMEOUT_SECONDS", 6.0, 1.0, 15.0)
        self.external_extractor_cache_ttl_seconds = _float_env("EXTERNAL_EXTRACTOR_CACHE_TTL_SECONDS", 45.0, 5.0, 300.0)
        self.external_extractor_user_agent = os.getenv(
            "EXTERNAL_EXTRACTOR_USER_AGENT",
            "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        ).strip()

        # HLS resilience. The live offset and real segment prefetch/cache replace
        # the old artificial FFmpeg-output delay as the primary buffer.
        self.hls_live_start_offset_seconds = _float_env("HLS_LIVE_START_OFFSET_SECONDS", 12.0, 0.0, 60.0)
        self.hls_prefetch_segments = _int_env("HLS_PREFETCH_SEGMENTS", 3, 0, 8)
        self.hls_segment_cache_items = _int_env("HLS_SEGMENT_CACHE_ITEMS", 96, 8, 512)
        self.hls_segment_cache_max_mb = _int_env("HLS_SEGMENT_CACHE_MAX_MB", 128, 16, 2048)
        self.hls_segment_cache_ttl_seconds = _float_env("HLS_SEGMENT_CACHE_TTL_SECONDS", 120.0, 5.0, 900.0)
        self.hls_playlist_inactivity_seconds = _float_env("HLS_PLAYLIST_INACTIVITY_SECONDS", 90.0, 15.0, 900.0)
        self.hls_upstream_timeout_seconds = _float_env("HLS_UPSTREAM_TIMEOUT_SECONDS", 5.0, 1.0, 30.0)
        self.hls_segment_retry_attempts = _int_env("HLS_SEGMENT_RETRY_ATTEMPTS", 2, 1, 5)
        self.hls_playlist_retry_attempts = _int_env("HLS_PLAYLIST_RETRY_ATTEMPTS", 2, 1, 5)
        self.hls_retry_base_seconds = _float_env("HLS_RETRY_BASE_SECONDS", 0.5, 0.1, 10.0)


settings = Settings()
