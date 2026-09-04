from pathlib import Path

path = Path("dlhd_proxy/step_daddy.py")
text = path.read_text()

# DLStreams can expose more than one playable option for a channel inside the
# same player family. The existing fallback patch correctly walks player
# families, but it only inspected the first iframe and the first embedded HLS
# URL in each page. That means a dead "Stream 1" could mask a healthy
# "Stream 2". Extend the patched resolver to walk every iframe and every
# embedded direct-HLS source, and remember the winning indexes per channel.

helper_start = text.index("def _extract_direct_hls_source(response_text: str) -> str | None:\n")
helper_end = text.index("def _direct_hls_token", helper_start)
helpers = '''def _extract_direct_hls_sources(response_text: str) -> list[str]:
    """Return all base64-embedded HTTP player sources in stable page order."""

    encoded_values = re.findall(
        r"source\\s*:\\s*(?:window\\.)?atob\\(\\s*['\\\"]([^'\\\"]+)['\\\"]\\s*\\)",
        response_text,
        re.IGNORECASE,
    )

    # Some DLStreams alternate-player pages no longer label every option with a
    # literal `source:` property. Look at other atob() values as well, but only
    # accept decoded HTTP(S) URLs; the media probe below decides whether they
    # are actually HLS.
    for encoded in re.findall(
        r"(?:window\\.)?atob\\(\\s*['\\\"]([^'\\\"]+)['\\\"]\\s*\\)",
        response_text,
        re.IGNORECASE,
    ):
        if encoded not in encoded_values:
            encoded_values.append(encoded)

    sources: list[str] = []
    for encoded in encoded_values:
        try:
            decoded = base64.b64decode(
                encoded + "=" * (-len(encoded) % 4)
            ).decode("utf-8").strip()
        except Exception:
            continue
        if not decoded.startswith(("http://", "https://")):
            continue
        if decoded not in sources:
            sources.append(decoded)
    return sources


def _extract_direct_hls_source(response_text: str) -> str | None:
    """Return the first direct player source for legacy callers."""

    sources = _extract_direct_hls_sources(response_text)
    return sources[0] if sources else None


'''
text = text[:helper_start] + helpers + text[helper_end:]

cache_start = text.index("        cached_folder = player_cache.get(channel_key)\n")
cache_end = text.index("\n\n        source_url = None", cache_start)
cache_block = '''        cached_entry = player_cache.get(channel_key)
        if isinstance(cached_entry, dict):
            cached_folder = cached_entry.get("folder")
            try:
                cached_embed = max(0, int(cached_entry.get("embed", 0)))
            except (TypeError, ValueError):
                cached_embed = 0
            try:
                cached_source = max(0, int(cached_entry.get("source", 0)))
            except (TypeError, ValueError):
                cached_source = 0
        else:
            # Backward-compatible with the original in-memory cache, which
            # stored only the winning family name.
            cached_folder = cached_entry
            cached_embed = 0
            cached_source = 0

        ordered_folders = (
            (cached_folder,) + tuple(folder for folder in player_folders if folder != cached_folder)
            if cached_folder in player_folders
            else player_folders
        )'''
text = text[:cache_start] + cache_block + text[cache_end:]

old_state = '''        direct_hls_prefetched_text = None
        legacy_candidate = None
'''
assert old_state in text, "player fallback state anchor changed"
text = text.replace(
    old_state,
    '''        direct_hls_prefetched_text = None
        direct_hls_selected_url = None
        legacy_candidate = None
''',
    1,
)

candidate_start = text.index("            candidate_url = urljoin(page_url, matches[0])\n")
candidate_end = text.index(
    "        if source_response is None and legacy_candidate is not None:\n",
    candidate_start,
)
candidate_block = '''            candidate_urls = []
            for match in matches:
                candidate_url = urljoin(page_url, match)
                if candidate_url not in candidate_urls:
                    candidate_urls.append(candidate_url)

            candidate_order = list(range(len(candidate_urls)))
            if (
                folder == cached_folder
                and 0 <= cached_embed < len(candidate_urls)
            ):
                candidate_order = [cached_embed] + [
                    index for index in candidate_order if index != cached_embed
                ]

            for embed_index in candidate_order:
                candidate_url = candidate_urls[embed_index]
                candidate_label = (
                    f"{folder}#{embed_index + 1}"
                    if len(candidate_urls) > 1
                    else folder
                )

                try:
                    candidate_response = await self._get(
                        candidate_url,
                        headers=self._headers(page_url),
                        timeout=12,
                    )
                except Exception as exc:
                    failures.append(
                        f"{candidate_label}: source {type(exc).__name__}"
                    )
                    continue

                if candidate_response.status_code >= 400:
                    failures.append(
                        f"{candidate_label}: source HTTP {candidate_response.status_code}"
                    )
                    continue

                direct_hls_urls = _extract_direct_hls_sources(candidate_response.text)
                source_order = list(range(len(direct_hls_urls)))
                if (
                    folder == cached_folder
                    and embed_index == cached_embed
                    and 0 <= cached_source < len(direct_hls_urls)
                ):
                    source_order = [cached_source] + [
                        index for index in source_order if index != cached_source
                    ]

                for source_index in source_order:
                    direct_hls_url = direct_hls_urls[source_index]
                    source_label = (
                        f"{candidate_label}/source#{source_index + 1}"
                        if len(direct_hls_urls) > 1
                        else candidate_label
                    )
                    healthy, detail, prefetched_text = await probe_direct_hls(
                        candidate_url,
                        direct_hls_url,
                    )
                    if not healthy:
                        failures.append(f"{source_label}: direct HLS {detail}")
                        continue

                    source_url = candidate_url
                    source_response = candidate_response
                    direct_hls_prefetched_text = prefetched_text
                    direct_hls_selected_url = direct_hls_url
                    player_cache[channel_key] = {
                        "folder": folder,
                        "embed": embed_index,
                        "source": source_index,
                    }
                    logger.info(
                        "Selected DLHD player family %s embed %s source %s for channel %s after media probe",
                        folder,
                        embed_index + 1,
                        source_index + 1,
                        channel_id,
                    )
                    break

                if source_response is not None:
                    break

                has_legacy_key = bool(
                    re.search(
                        rf"const\\s+{re.escape(key)}\\s*=\\s*\\\".*?\\\";",
                        candidate_response.text,
                    )
                )
                if has_legacy_key and legacy_candidate is None:
                    legacy_candidate = (
                        folder,
                        embed_index,
                        candidate_url,
                        candidate_response,
                    )
                elif not direct_hls_urls:
                    failures.append(f"{candidate_label}: unsupported player")

            if source_response is not None:
                break

'''
text = text[:candidate_start] + candidate_block + text[candidate_end:]

legacy_start = text.index(
    "        if source_response is None and legacy_candidate is not None:\n",
    candidate_start,
)
legacy_end = text.index("        if source_response is None:\n", legacy_start)
legacy_block = '''        if source_response is None and legacy_candidate is not None:
            folder, embed_index, source_url, source_response = legacy_candidate
            player_cache[channel_key] = {
                "folder": folder,
                "embed": embed_index,
                "source": 0,
            }
            logger.info(
                "Selected legacy DLHD player family %s embed %s for channel %s",
                folder,
                embed_index + 1,
                channel_id,
            )

'''
text = text[:legacy_start] + legacy_block + text[legacy_end:]

old_failure = '''        if source_response is None:
            detail = "; ".join(failures[-6:]) or "no player candidates"
            raise ValueError(f"No supported DLHD player source found ({detail})")
'''
assert old_failure in text, "player fallback failure anchor changed"
text = text.replace(
    old_failure,
    '''        if source_response is None:
            player_cache.pop(channel_key, None)
            detail = "; ".join(failures[-12:]) or "no player candidates"
            raise ValueError(f"No supported DLHD player source found ({detail})")
''',
    1,
)

old_direct = '''        direct_hls_url = _extract_direct_hls_source(source_response.text)
        if direct_hls_url:
'''
assert old_direct in text, "selected direct-HLS anchor changed"
text = text.replace(
    old_direct,
    '''        direct_hls_url = direct_hls_selected_url or _extract_direct_hls_source(source_response.text)
        if direct_hls_url:
''',
    1,
)

path.write_text(text)
