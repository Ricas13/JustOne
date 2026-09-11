import os


class Settings:
    def __init__(self) -> None:
        self.base_url = os.getenv("DLHD_BASE_URL", "https://daddylivestream.com").rstrip("/")
        self.api_url = os.getenv("API_URL", "http://localhost:3000").rstrip("/")
        self.socks5 = os.getenv("SOCKS5", "").strip()
        self.refresh_seconds = max(60, int(os.getenv("CHANNEL_REFRESH_SECONDS", "300")))


settings = Settings()
