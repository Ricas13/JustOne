import os


class Settings:
    def __init__(self) -> None:
        self.base_url = os.getenv("DLHD_BASE_URL", "https://daddylivestream.com").rstrip("/")
        self.playback_base_url = os.getenv(
            "DLHD_EASYPROXY_BASE_URL",
            "https://daddylive.sx",
        ).rstrip("/")
        self.socks5 = os.getenv("SOCKS5", "").strip()
        self.refresh_seconds = max(60, int(os.getenv("CHANNEL_REFRESH_SECONDS", "300")))


settings = Settings()
