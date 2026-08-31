from pathlib import Path

path = Path("dlhd_proxy/step_daddy.py")
text = path.read_text()

# The upstream implementation only opens /stream/stream-<id>.php. DLStreams
# exposes several player families for the same channel and the first family can
# be unavailable even while another player works. Keep the existing direct-HLS
# and legacy parsers, but choose a supported player page before entering them.
old = '''    async def stream(self, channel_id: str):
        key = "CHANNEL_KEY"
        url = f"{self._base_url}/stream/stream-{channel_id}.php"
        response = await self._get(url, headers=self._headers())
        matches = re.compile("iframe src=\\\"(.*)\\\" width").findall(response.text)
        if matches:
            source_url = matches[0]
            source_response = await self._get(source_url, headers=self._headers(url))
        else:
            raise ValueError("Failed to find source URL for channel")

'''
assert old in text, "patched upstream stream entry anchor changed"

new = '''    async def stream(self, channel_id: str):
        key = "CHANNEL_KEY"
        channel_key = str(channel_id)
        player_folders = ("stream", "watch", "cast", "plus", "player", "casting")

        # A successful alternate is very likely to remain the best choice for
        # subsequent tunes. Try it first, while still falling back across every
        # documented player family if it stops working.
        player_cache = getattr(self, "_player_folder_cache", None)
        if player_cache is None:
            player_cache = {}
            self._player_folder_cache = player_cache
        cached_folder = player_cache.get(channel_key)
        ordered_folders = (
            (cached_folder,) + tuple(folder for folder in player_folders if folder != cached_folder)
            if cached_folder in player_folders
            else player_folders
        )

        source_url = None
        source_response = None
        legacy_candidate = None
        failures = []

        for folder in ordered_folders:
            page_url = f"{self._base_url}/{folder}/stream-{channel_id}.php"
            try:
                response = await self._get(
                    page_url,
                    headers=self._headers(),
                    timeout=12,
                )
            except Exception as exc:
                failures.append(f"{folder}: page {type(exc).__name__}")
                if cached_folder == folder:
                    player_cache.pop(channel_key, None)
                continue

            if response.status_code >= 400:
                failures.append(f"{folder}: page HTTP {response.status_code}")
                if cached_folder == folder:
                    player_cache.pop(channel_key, None)
                continue

            matches = re.findall(
                r'<iframe[^>]+src=["\\\']([^"\\\']+)["\\\']',
                response.text,
                re.IGNORECASE,
            )
            if not matches:
                failures.append(f"{folder}: no iframe")
                continue

            candidate_url = urljoin(page_url, matches[0])
            try:
                candidate_response = await self._get(
                    candidate_url,
                    headers=self._headers(page_url),
                    timeout=12,
                )
            except Exception as exc:
                failures.append(f"{folder}: source {type(exc).__name__}")
                continue

            if candidate_response.status_code >= 400:
                failures.append(f"{folder}: source HTTP {candidate_response.status_code}")
                continue

            has_direct_hls = bool(_extract_direct_hls_source(candidate_response.text))
            has_legacy_key = bool(
                re.search(
                    rf"const\\s+{re.escape(key)}\\s*=\\s*\\\".*?\\\";",
                    candidate_response.text,
                )
            )

            # Prefer the current direct-HLS protocol. If an older player still
            # exposes CHANNEL_KEY remember it, but continue looking for a direct
            # player before falling back to the legacy parser below.
            if has_direct_hls:
                source_url = candidate_url
                source_response = candidate_response
                player_cache[channel_key] = folder
                logger.info(
                    "Selected DLHD player family %s for channel %s",
                    folder,
                    channel_id,
                )
                break

            if has_legacy_key and legacy_candidate is None:
                legacy_candidate = (folder, candidate_url, candidate_response)
            else:
                failures.append(f"{folder}: unsupported player")

        if source_response is None and legacy_candidate is not None:
            folder, source_url, source_response = legacy_candidate
            player_cache[channel_key] = folder
            logger.info(
                "Selected legacy DLHD player family %s for channel %s",
                folder,
                channel_id,
            )

        if source_response is None:
            detail = "; ".join(failures[-6:]) or "no player candidates"
            raise ValueError(f"No supported DLHD player source found ({detail})")

'''

path.write_text(text.replace(old, new, 1))
