import base64
import html
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

from curl_cffi import AsyncSession

from settings import settings
from utils import decode_bundle, decrypt, encrypt

logger = logging.getLogger(__name__)

VISIBLE_MEDIA_SUFFIXES = {
    ".ts", ".m4s", ".m4a", ".mp4", ".aac", ".mp3", ".vtt", ".webvtt",
    ".mpegts", ".m2ts", ".mts", ".cmfv", ".cmfa", ".fmp4", ".bin", ".key",
}


@dataclass
class Channel:
    id: str
    name: str


def extract_direct_hls_sources(response_text: str) -> list[str]:
    encoded_values = re.findall(
        r"source\s*:\s*(?:window\.)?atob\(\s*['\"]([^'\"]+)['\"]\s*\)",
        response_text,
        re.IGNORECASE,
    )
    for encoded in re.findall(
        r"(?:window\.)?atob\(\s*['\"]([^'\"]+)['\"]\s*\)",
        response_text,
        re.IGNORECASE,
    ):
        if encoded not in encoded_values:
            encoded_values.append(encoded)

    out: list[str] = []
    for encoded in encoded_values:
        try:
            decoded = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8").strip()
        except Exception:
            continue
        if decoded.startswith(("http://", "https://")) and decoded not in out:
            out.append(decoded)
    return out


def _target_token(url: str, referer: str, origin: str = "") -> str:
    return encrypt(json.dumps(
        {"url": url, "referer": referer, "origin": origin},
        separators=(",", ":"),
    ))


def decode_target(path: str) -> tuple[str, str, str]:
    token = re.sub(
        r"\.(?:m3u8|ts|m4s|m4a|mp4|aac|mp3|vtt|webvtt|mpegts|m2ts|mts|cmfv|cmfa|fmp4|bin|key)$",
        "",
        str(path),
        flags=re.IGNORECASE,
    )
    try:
        data = json.loads(decrypt(token))
    except Exception as exc:
        raise ValueError("Invalid HLS target") from exc
    url = str(data.get("url") or "")
    referer = str(data.get("referer") or "")
    origin = str(data.get("origin") or "")
    if not url.startswith(("http://", "https://")):
        raise ValueError("Invalid HLS URL")
    if not referer:
        referer = url
    return url, referer, origin


def _visible_suffix(url: str, *, playlist: bool = False, key: bool = False, init: bool = False) -> str:
    if playlist:
        return ".m3u8"
    if key:
        return ".key"
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix == ".m3u8":
        return ".m3u8"
    if suffix in VISIBLE_MEDIA_SUFFIXES:
        return suffix
    if init:
        return ".mp4"
    return ".ts"


def proxy_url(
    url: str,
    referer: str,
    *,
    origin: str = "",
    playlist: bool = False,
    key: bool = False,
    init: bool = False,
) -> str:
    return (
        f"{settings.api_url}/hls/{_target_token(url, referer, origin)}"
        f"{_visible_suffix(url, playlist=playlist, key=key, init=init)}"
    )


def rewrite_hls_playlist(
    payload: str,
    playlist_url: str,
    referer_url: str | None = None,
    *,
    key_referer_url: str | None = None,
    key_origin: str = "",
) -> str:
    referer = referer_url or playlist_url
    rewritten: list[str] = []
    next_line_is_playlist = False

    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if line.startswith("#"):
            uri_is_playlist = bool(re.match(r"#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)", line, re.IGNORECASE))
            uri_is_key = bool(re.match(r"#EXT-X-KEY", line, re.IGNORECASE))
            uri_is_init = bool(re.match(r"#EXT-X-MAP", line, re.IGNORECASE))

            if "URI=" in line:
                def repl(match):
                    absolute = urljoin(playlist_url, match.group(2))
                    replacement = proxy_url(
                        absolute,
                        key_referer_url or referer if uri_is_key else referer,
                        origin=key_origin if uri_is_key else "",
                        playlist=uri_is_playlist,
                        key=uri_is_key,
                        init=uri_is_init,
                    )
                    return f"{match.group(1)}{replacement}{match.group(3)}"

                line = re.sub(r"(URI=['\"])(.*?)(['\"])", repl, line)

            rewritten.append(line)
            next_line_is_playlist = bool(re.match(r"#EXT-X-STREAM-INF", line, re.IGNORECASE))
            continue

        if line:
            absolute = urljoin(playlist_url, line)
            parsed = urlparse(absolute)
            line = proxy_url(
                absolute,
                referer,
                playlist=next_line_is_playlist or parsed.path.lower().endswith(".m3u8"),
            )
        rewritten.append(line)
        next_line_is_playlist = False

    return "\n".join(rewritten) + "\n"


class Provider:
    def __init__(self) -> None:
        self._session = AsyncSession(proxy=f"socks5://{settings.socks5}" if settings.socks5 else None)
        self.channels: list[Channel] = []

    def headers(self, referer: str | None = None, origin: str | None = None) -> dict[str, str]:
        referer = referer or settings.base_url
        headers = {
            "Referer": referer,
            "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        }
        if origin:
            headers["Origin"] = origin
        return headers

    async def _get(self, url: str, **kwargs):
        return await self._session.get(url, **kwargs)

    async def load_channels(self) -> None:
        url = f"{settings.base_url}/24-7-channels.php"
        response = await self._get(url, headers=self.headers(), timeout=20)
        if response.status_code >= 400:
            raise ValueError(f"Channel list HTTP {response.status_code}")

        matches = re.findall(
            r'href="/watch\.php\?id=(\d+)"[^>]*>\s*<div class="card__title">(.*?)</div>',
            response.text,
            re.DOTALL,
        )
        seen: set[str] = set()
        channels: list[Channel] = []
        for channel_id, channel_name in matches:
            if channel_id in seen:
                continue
            seen.add(channel_id)
            name = html.unescape(channel_name.strip()).replace("#", "")
            channels.append(Channel(id=channel_id, name=name))

        # Duplicate names stay duplicate here. The Jellyfin layer owns merging,
        # and preserves these rows in provider order as candidate 1, 2, 3...
        self.channels = channels
        logger.info("Loaded %d raw DLHD channels", len(channels))

    async def _legacy_stream(self, source_url: str, source_text: str) -> str:
        matches = re.findall(r'const\s+CHANNEL_KEY\s*=\s*"(.*?)";', source_text)
        if not matches:
            raise ValueError("Selected source has no supported stream")
        channel_key = matches[-1]

        data = decode_bundle(source_text)
        auth_ts = data.get("b_ts", "")
        auth_sig = data.get("b_sig", "")
        auth_rnd = data.get("b_rnd", "")
        auth_url = data.get("b_host", "")
        if not all((auth_ts, auth_sig, auth_rnd, auth_url)):
            raise ValueError("Legacy auth bundle missing")

        auth_request_url = f"{auth_url}auth.php?channel_id={channel_key}&ts={auth_ts}&rnd={auth_rnd}&sig={auth_sig}"
        auth_response = await self._get(auth_request_url, headers=self.headers(source_url), timeout=12)
        if auth_response.status_code != 200:
            raise ValueError(f"Legacy auth HTTP {auth_response.status_code}")

        parsed_source = urlparse(source_url)
        lookup_url = f"{parsed_source.scheme}://{parsed_source.netloc}/server_lookup.php?channel_id={channel_key}"
        lookup_response = await self._get(lookup_url, headers=self.headers(source_url), timeout=12)
        if lookup_response.status_code >= 400:
            raise ValueError(f"Server lookup HTTP {lookup_response.status_code}")
        server_key = lookup_response.json().get("server_key")
        if not server_key:
            raise ValueError("No server key")

        if server_key == "top1/cdn":
            stream_url = f"https://top1.newkso.ru/top1/cdn/{channel_key}/mono.m3u8"
        else:
            stream_url = f"https://{server_key}new.newkso.ru/{server_key}/{channel_key}/mono.m3u8"

        response = await self._get(stream_url, headers=self.headers(quote(str(source_url))), timeout=12)
        if response.status_code >= 400:
            raise ValueError(f"Legacy playlist HTTP {response.status_code}")
        if not response.text.lstrip().startswith("#EXTM3U"):
            raise ValueError("Legacy source did not return HLS")

        # Legacy keys require the player host as both the Referer basis and
        # Origin. Ordinary media stays on the simple HLS proxy path.
        return rewrite_hls_playlist(
            response.text,
            stream_url,
            source_url,
            key_referer_url=f"{parsed_source.netloc}/",
            key_origin=parsed_source.netloc,
        )

    async def _direct_stream(self, direct_url: str, source_url: str, source_number: int) -> str:
        response = await self._get(direct_url, headers=self.headers(source_url), timeout=12)
        if response.status_code >= 400:
            raise ValueError(f"Source {source_number} playlist HTTP {response.status_code}")
        if not response.text.lstrip().startswith("#EXTM3U"):
            raise ValueError(f"Source {source_number} returned invalid HLS")
        return rewrite_hls_playlist(response.text, str(response.url), source_url)

    async def stream(self, channel_id: str, source_index: int = 0) -> str:
        """Resolve exactly one provider option by stable, zero-based page order."""
        if source_index < 0:
            raise ValueError("source must be >= 0")

        page_url = f"{settings.base_url}/stream/stream-{channel_id}.php"
        page = await self._get(page_url, headers=self.headers(), timeout=12)
        if page.status_code >= 400:
            raise ValueError(f"Player page HTTP {page.status_code}")

        iframe_paths = re.findall(
            r'<iframe[^>]+src=["\']([^"\']+)["\']',
            page.text,
            re.IGNORECASE,
        )
        player_urls = [urljoin(page_url, value) for value in iframe_paths]
        if not player_urls:
            player_urls = [page_url]

        option = 0
        for player_url in player_urls:
            try:
                player = page if player_url == page_url else await self._get(
                    player_url,
                    headers=self.headers(page_url),
                    timeout=12,
                )
            except Exception as exc:
                if option == source_index:
                    raise ValueError(f"Source {option + 1} request failed: {type(exc).__name__}") from exc
                option += 1
                continue

            if player.status_code >= 400:
                if option == source_index:
                    raise ValueError(f"Source {option + 1} HTTP {player.status_code}")
                option += 1
                continue

            direct_sources = extract_direct_hls_sources(player.text)
            if direct_sources:
                for direct_url in direct_sources:
                    if option == source_index:
                        logger.info("Channel %s selected source %s (direct HLS)", channel_id, option + 1)
                        return await self._direct_stream(direct_url, player_url, option + 1)
                    option += 1
                continue

            if "CHANNEL_KEY" in player.text:
                if option == source_index:
                    logger.info("Channel %s selected source %s (legacy)", channel_id, option + 1)
                    return await self._legacy_stream(player_url, player.text)
                option += 1
                continue

            if option == source_index:
                raise ValueError(f"Source {option + 1} is unsupported")
            option += 1

        raise ValueError(f"Source {source_index + 1} does not exist")

    async def close(self) -> None:
        await self._session.close()
