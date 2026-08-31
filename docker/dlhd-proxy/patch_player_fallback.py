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

        async def probe_direct_hls(player_url: str, hls_url: str):
            """Validate a player through its first real HLS media object."""

            headers = self._headers(player_url)
            current_url = hls_url
            root_payload = None

            for _depth in range(3):
                try:
                    hls_response = await self._get(
                        current_url,
                        headers=headers,
                        timeout=8,
                    )
                except Exception as exc:
                    return False, f"playlist {type(exc).__name__}", None

                if hls_response.status_code >= 400:
                    return False, f"playlist HTTP {hls_response.status_code}", None

                payload = hls_response.text
                if not payload.lstrip().startswith("#EXTM3U"):
                    return False, "playlist invalid", None
                if root_payload is None:
                    root_payload = payload

                lines = [line.strip() for line in payload.splitlines() if line.strip()]

                # Master playlist: recurse into the first advertised variant.
                if any(line.upper().startswith("#EXT-X-STREAM-INF") for line in lines):
                    child = next((line for line in lines if not line.startswith("#")), None)
                    if not child:
                        return False, "master had no child", None
                    current_url = urljoin(current_url, child)
                    continue

                # Media playlists can require a key and/or fMP4 init object.
                for tag_name in ("#EXT-X-KEY", "#EXT-X-MAP"):
                    tagged = next((line for line in lines if line.upper().startswith(tag_name)), None)
                    if not tagged:
                        continue
                    uri_match = re.search(r'URI=["\\\']([^"\\\']+)["\\\']', tagged, re.IGNORECASE)
                    if not uri_match:
                        continue
                    asset_url = urljoin(current_url, uri_match.group(1))
                    try:
                        asset_response = await self._get(
                            asset_url,
                            headers=headers,
                            timeout=8,
                        )
                    except Exception as exc:
                        return False, f"{tag_name[7:].lower()} {type(exc).__name__}", None
                    if asset_response.status_code >= 400 or not asset_response.content:
                        return False, f"{tag_name[7:].lower()} HTTP {asset_response.status_code}", None

                segment = next((line for line in lines if not line.startswith("#")), None)
                if not segment:
                    # Low-latency HLS can advertise only PART URIs at the edge.
                    part = next((line for line in lines if line.upper().startswith("#EXT-X-PART:")), None)
                    part_match = re.search(r'URI=["\\\']([^"\\\']+)["\\\']', part or "", re.IGNORECASE)
                    segment = part_match.group(1) if part_match else None
                if not segment:
                    return False, "media playlist had no segment", None

                segment_url = urljoin(current_url, segment)
                range_headers = {**headers, "Range": "bytes=0-4095"}
                try:
                    segment_response = await self._get(
                        segment_url,
                        headers=range_headers,
                        timeout=8,
                    )
                    # Some signed CDNs reject Range even though a normal GET is
                    # fine. Retry once without Range before rejecting the family.
                    if segment_response.status_code >= 400:
                        segment_response = await self._get(
                            segment_url,
                            headers=headers,
                            timeout=8,
                        )
                except Exception as exc:
                    return False, f"segment {type(exc).__name__}", None

                if segment_response.status_code >= 400:
                    return False, f"segment HTTP {segment_response.status_code}", None
                if not segment_response.content:
                    return False, "segment empty", None
                return True, "media ok", root_payload

            return False, "playlist nesting exceeded", None

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
        direct_hls_prefetched_text = None
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

            direct_hls_url = _extract_direct_hls_source(candidate_response.text)
            has_direct_hls = False
            prefetched_text = None
            if direct_hls_url:
                healthy, detail, prefetched_text = await probe_direct_hls(
                    candidate_url,
                    direct_hls_url,
                )
                has_direct_hls = healthy
                if not healthy:
                    failures.append(f"{folder}: direct HLS {detail}")
                    if cached_folder == folder:
                        player_cache.pop(channel_key, None)

            has_legacy_key = bool(
                re.search(
                    rf"const\\s+{re.escape(key)}\\s*=\\s*\\\".*?\\\";",
                    candidate_response.text,
                )
            )

            # Prefer a direct-HLS player only after it has proved that its
            # manifest tree reaches a real media object. Merely containing an
            # embedded URL is not enough: stale DLStreams players can keep a
            # valid-looking URL after their child playlist/segments have died.
            if has_direct_hls:
                source_url = candidate_url
                source_response = candidate_response
                direct_hls_prefetched_text = prefetched_text
                player_cache[channel_key] = folder
                logger.info(
                    "Selected DLHD player family %s for channel %s after media probe",
                    folder,
                    channel_id,
                )
                break

            if has_legacy_key and legacy_candidate is None:
                legacy_candidate = (folder, candidate_url, candidate_response)
            elif not direct_hls_url:
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

text = text.replace(old, new, 1)

# patch_upstream.py normally fetches the chosen direct manifest after player
# selection. The media probe already fetched and validated that root manifest,
# so reuse it. This removes a race/duplicate request and guarantees the selected
# family is the same one whose media tree was just proven healthy.
direct_old = '''        direct_hls_url = _extract_direct_hls_source(source_response.text)
        if direct_hls_url:
            direct_response = await self._get(
                direct_hls_url,
                headers=self._headers(source_url),
            )
            if direct_response.status_code >= 400:
                raise ValueError(
                    f"Direct HLS source returned HTTP {direct_response.status_code}"
                )
            if "#EXTM3U" not in direct_response.text[:256]:
                raise ValueError("Direct HLS source did not return an HLS playlist")
            logger.info("Resolved channel %s through direct embedded HLS", channel_id)
            return _rewrite_direct_hls_playlist(
                direct_response.text,
                direct_hls_url,
                source_url,
            )

'''
assert direct_old in text, "direct HLS fetch anchor changed"

direct_new = '''        direct_hls_url = _extract_direct_hls_source(source_response.text)
        if direct_hls_url:
            direct_payload = direct_hls_prefetched_text
            if direct_payload is None:
                direct_response = await self._get(
                    direct_hls_url,
                    headers=self._headers(source_url),
                    timeout=12,
                )
                if direct_response.status_code >= 400:
                    raise ValueError(
                        f"Direct HLS source returned HTTP {direct_response.status_code}"
                    )
                direct_payload = direct_response.text
            if "#EXTM3U" not in direct_payload[:256]:
                raise ValueError("Direct HLS source did not return an HLS playlist")
            logger.info("Resolved channel %s through media-validated direct HLS", channel_id)
            return _rewrite_direct_hls_playlist(
                direct_payload,
                direct_hls_url,
                source_url,
            )

'''
text = text.replace(direct_old, direct_new, 1)

path.write_text(text)
