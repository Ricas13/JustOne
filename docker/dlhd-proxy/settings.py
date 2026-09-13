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


class Settings:
    def __init__(self) -> None:
        self.base_url = os.getenv("DLHD_BASE_URL", "https://daddylivestream.com").rstrip("/")
        self.api_url = os.getenv("API_URL", "http://localhost:3000").rstrip("/")
        self.socks5 = os.getenv("SOCKS5", "").strip()
        self.refresh_seconds = max(60, int(os.getenv("CHANNEL_REFRESH_SECONDS", "300")))

        # Resolver retries are deliberately bounded. They are useful for the short
        # 5xx bursts DLHD exhibits, but we never keep hammering a dead source.
        self.source_retry_attempts = _int_env("DLHD_SOURCE_RETRY_ATTEMPTS", 3, 1, 5)
        self.source_retry_base_seconds = _float_env("DLHD_SOURCE_RETRY_BASE_SECONDS", 1.0, 0.1, 10.0)

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
