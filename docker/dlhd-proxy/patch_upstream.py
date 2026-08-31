from pathlib import Path

path = Path("dlhd_proxy/step_daddy.py")
text = path.read_text()

# Current DLHD embeds a direct HLS source in the player as
# source: window.atob('...'). Keep the pinned amddeus implementation, but add
# support for that protocol before its legacy CHANNEL_KEY/auth flow.
assert "import json\n" in text
text = text.replace("import json\n", "import base64\nimport json\n", 1)

old_import = "from urllib.parse import parse_qs, quote, urlparse, urlsplit\n"
assert old_import in text
text = text.replace(
    old_import,
    "from urllib.parse import parse_qs, quote, urljoin, urlparse, urlsplit\n",
    1,
)

helper_anchor = '''def _is_hls_path(path: str) -> bool:\n    \"\"\"Return ``True`` when *path* points to a proxyable HLS asset.\"\"\"\n\n    suffix = Path(path).suffix.lower()\n    return suffix in PROXYABLE_HLS_EXTENSIONS\n\n\n'''
assert helper_anchor in text, "upstream HLS helper anchor changed"

helpers = '''def _extract_direct_hls_source(response_text: str) -> str | None:\n    \"\"\"Extract a base64-embedded direct HLS source from the DLHD player.\"\"\"\n\n    match = re.search(\n        r\"source\\s*:\\s*(?:window\\.)?atob\\(\\s*['\\\"]([^'\\\"]+)['\\\"]\\s*\\)\",\n        response_text,\n        re.IGNORECASE,\n    )\n    if not match:\n        return None\n\n    encoded = match.group(1)\n    try:\n        decoded = base64.b64decode(encoded + \"=\" * (-len(encoded) % 4)).decode(\"utf-8\").strip()\n    except Exception:\n        return None\n\n    if not decoded.startswith((\"http://\", \"https://\")):\n        return None\n    return decoded\n\n\ndef _direct_hls_token(url: str, referer_url: str) -> str:\n    payload = json.dumps(\n        {\"url\": url, \"referer\": referer_url},\n        separators=(\",\", \":\"),\n    )\n    return encrypt(payload)\n\n\n_DIRECT_HLS_MEDIA_SUFFIXES = {\n    \".ts\", \".m4s\", \".m4a\", \".mp4\", \".aac\", \".mp3\",\n    \".vtt\", \".webvtt\", \".mpegts\", \".m2ts\", \".mts\",\n    \".cmfv\", \".cmfa\", \".fmp4\", \".bin\", \".key\",\n}\n\n\ndef _direct_hls_suffix(\n    url: str,\n    *,\n    playlist: bool = False,\n    key: bool = False,\n    init: bool = False,\n) -> str:\n    \"\"\"Return an FFmpeg-safe visible suffix for an encrypted HLS proxy URL.\"\"\"\n\n    if playlist:\n        return \".m3u8\"\n    if key:\n        return \".key\"\n\n    try:\n        suffix = Path(urlparse(url).path).suffix.lower()\n    except Exception:\n        suffix = \"\"\n\n    if suffix == \".m3u8\":\n        return \".m3u8\"\n    if suffix in _DIRECT_HLS_MEDIA_SUFFIXES:\n        return suffix\n    if init:\n        return \".mp4\"\n\n    # DLStreams commonly hides MPEG-TS segment names behind extensionless URLs.\n    # FFmpeg's HLS demuxer rejects those before it even makes the HTTP request,\n    # so expose a harmless .ts suffix while keeping the encrypted target intact.\n    return \".ts\"\n\n\ndef _direct_hls_proxy_url(\n    url: str,\n    referer_url: str,\n    *,\n    playlist: bool = False,\n    key: bool = False,\n    init: bool = False,\n) -> str:\n    token = _direct_hls_token(url, referer_url)\n    suffix = _direct_hls_suffix(url, playlist=playlist, key=key, init=init)\n    return f\"{config.api_url}/hls/{token}{suffix}\"\n\n\ndef _decode_direct_hls_target(path: str) -> tuple[str, str]:\n    # The suffix is presentation-only for FFmpeg. It is not part of the\n    # encrypted token and must be removed before decrypting the target.\n    token = re.sub(\n        r\"\\.(?:m3u8|ts|m4s|m4a|mp4|aac|mp3|vtt|webvtt|mpegts|m2ts|mts|cmfv|cmfa|fmp4|bin|key)$\",\n        \"\",\n        str(path),\n        flags=re.IGNORECASE,\n    )\n    payload = decrypt(token)\n    try:\n        data = json.loads(payload)\n    except json.JSONDecodeError as exc:\n        raise ValueError(\"Invalid direct-HLS target\") from exc\n\n    url = str(data.get(\"url\") or \"\")\n    referer = str(data.get(\"referer\") or \"\")\n    if not url.startswith((\"http://\", \"https://\")):\n        raise ValueError(\"Invalid direct-HLS URL\")\n    if not referer.startswith((\"http://\", \"https://\")):\n        referer = url\n    return url, referer\n\n\ndef _rewrite_direct_hls_playlist(\n    payload: str,\n    playlist_url: str,\n    referer_url: str | None = None,\n) -> str:\n    \"\"\"Recursively proxy direct-HLS assets with the original player referer.\"\"\"\n\n    referer_url = referer_url or playlist_url\n    rewritten: list[str] = []\n    next_line_is_playlist = False\n\n    def proxy_url(\n        value: str,\n        *,\n        playlist: bool = False,\n        key: bool = False,\n        init: bool = False,\n    ) -> str:\n        absolute = urljoin(playlist_url, value)\n        return _direct_hls_proxy_url(\n            absolute,\n            referer_url,\n            playlist=playlist,\n            key=key,\n            init=init,\n        )\n\n    for raw_line in payload.splitlines():\n        line = raw_line.strip()\n\n        if line.startswith(\"#\"):\n            uri_is_playlist = bool(\n                re.match(\n                    r\"#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)\",\n                    line,\n                    re.IGNORECASE,\n                )\n            )\n            uri_is_key = bool(re.match(r\"#EXT-X-KEY\", line, re.IGNORECASE))\n            uri_is_init = bool(re.match(r\"#EXT-X-MAP\", line, re.IGNORECASE))\n\n            if \"URI=\" in line:\n                def replace_uri(match):\n                    return (\n                        f\"{match.group(1)}\"\n                        f\"{proxy_url(match.group(2), playlist=uri_is_playlist, key=uri_is_key, init=uri_is_init)}\"\n                        f\"{match.group(3)}\"\n                    )\n\n                line = re.sub(r\"(URI=['\\\"])(.*?)(['\\\"])\", replace_uri, line)\n\n            rewritten.append(line)\n            next_line_is_playlist = bool(\n                re.match(r\"#EXT-X-STREAM-INF\", line, re.IGNORECASE)\n            )\n            continue\n\n        if line:\n            absolute = urljoin(playlist_url, line)\n            parsed = urlparse(absolute)\n            if _is_hls_path((parsed.path or \"\").lower()) or config.proxy_content:\n                line = proxy_url(\n                    line,\n                    playlist=(\n                        next_line_is_playlist\n                        or (parsed.path or \"\").lower().endswith(\".m3u8\")\n                    ),\n                )\n\n        rewritten.append(line)\n        next_line_is_playlist = False\n\n    return \"\\n\".join(rewritten) + \"\\n\"\n\n\n'''
text = text.replace(helper_anchor, helper_anchor + helpers, 1)

legacy_anchor = '''        channel_key = re.compile(rf\"const\\s+{re.escape(key)}\\s*=\\s*\\\"(.*?)\\\";\").findall(source_response.text)[-1]\n\n        data = decode_bundle(source_response.text)\n'''
assert legacy_anchor in text, "upstream stream parser anchor changed"

replacement = '''        # New DLHD player: the HLS URL is embedded directly in a base64 atob()\n        # expression. Prefer it when present; retain the old auth flow below for\n        # older player hosts.\n        direct_hls_url = _extract_direct_hls_source(source_response.text)\n        if direct_hls_url:\n            direct_response = await self._get(\n                direct_hls_url,\n                headers=self._headers(source_url),\n            )\n            if direct_response.status_code >= 400:\n                raise ValueError(\n                    f\"Direct HLS source returned HTTP {direct_response.status_code}\"\n                )\n            if \"#EXTM3U\" not in direct_response.text[:256]:\n                raise ValueError(\"Direct HLS source did not return an HLS playlist\")\n            logger.info(\"Resolved channel %s through direct embedded HLS\", channel_id)\n            return _rewrite_direct_hls_playlist(\n                direct_response.text,\n                direct_hls_url,\n                source_url,\n            )\n\n        channel_matches = re.compile(\n            rf\"const\\s+{re.escape(key)}\\s*=\\s*\\\"(.*?)\\\";\"\n        ).findall(source_response.text)\n        if not channel_matches:\n            raise ValueError(\"No supported DLHD player source found\")\n        channel_key = channel_matches[-1]\n\n        data = decode_bundle(source_response.text)\n'''
text = text.replace(legacy_anchor, replacement, 1)

path.write_text(text)

# The direct-HLS player can return a master playlist. The upstream /content
# endpoint is intentionally a byte proxy, so it cannot recurse into that child
# playlist and it also drops the player Referer. Add a separate encrypted HLS
# route that carries the original referer through every playlist/segment/key
# request and recursively rewrites child manifests.
backend_path = Path("dlhd_proxy/backend.py")
backend = backend_path.read_text()

old_backend_import = "from dlhd_proxy.step_daddy import Channel, StepDaddy\n"
assert old_backend_import in backend, "backend StepDaddy import anchor changed"
backend = backend.replace(
    old_backend_import,
    "from dlhd_proxy.step_daddy import (\n"
    "    Channel,\n"
    "    StepDaddy,\n"
    "    _decode_direct_hls_target,\n"
    "    _rewrite_direct_hls_playlist,\n"
    ")\n",
    1,
)

# httpx 0.28's AsyncClient.send() does not accept a per-call timeout keyword.
# The shared client already has a 60-second read timeout, so remove the stale
# argument from the pinned upstream content proxy as well as the new HLS route.
old_content_send = '''        response = await client.send(\n            client.build_request(\"GET\", url),\n            stream=True,\n            timeout=60,\n        )\n'''
assert old_content_send in backend, "backend content send anchor changed"
backend = backend.replace(
    old_content_send,
    '''        response = await client.send(\n            client.build_request(\"GET\", url),\n            stream=True,\n        )\n''',
    1,
)

content_anchor = '''@fastapi_app.get(\"/content/{path}\")\nasync def content(path: str):\n'''
assert content_anchor in backend, "backend content route anchor changed"

hls_route = '''@fastapi_app.get(\"/hls/{path}\")\nasync def hls_content(path: str):\n    try:\n        url, referer = _decode_direct_hls_target(path)\n    except Exception as exc:\n        logger.warning(\"Invalid direct-HLS path provided: %s\", exc)\n        return JSONResponse(\n            content={\"error\": \"Invalid HLS request\"},\n            status_code=status.HTTP_400_BAD_REQUEST,\n        )\n\n    try:\n        response = await client.send(\n            client.build_request(\n                \"GET\",\n                url,\n                headers=step_daddy._headers(referer),\n            ),\n            stream=True,\n        )\n    except httpx.RequestError:\n        logger.exception(\"Direct-HLS proxy request failed for %s\", url)\n        return JSONResponse(\n            content={\"error\": \"Unable to reach upstream HLS content\"},\n            status_code=status.HTTP_502_BAD_GATEWAY,\n        )\n\n    if response.status_code >= 400:\n        upstream_status = response.status_code\n        logger.warning(\n            \"Direct-HLS upstream returned %s for %s\",\n            upstream_status,\n            url,\n        )\n        await response.aclose()\n        return JSONResponse(\n            content={\"error\": \"Upstream HLS content returned an error\"},\n            status_code=upstream_status,\n        )\n\n    effective_url = str(response.url)\n    media_type = response.headers.get(\n        \"content-type\",\n        \"application/octet-stream\",\n    )\n    is_playlist = (\n        \"mpegurl\" in media_type.lower()\n        or \"m3u8\" in media_type.lower()\n        or urlparse(effective_url).path.lower().endswith(\".m3u8\")\n    )\n\n    if is_playlist:\n        payload = (await response.aread()).decode(\"utf-8\", errors=\"replace\")\n        await response.aclose()\n        if not payload.lstrip().startswith(\"#EXTM3U\"):\n            logger.warning(\"Direct-HLS child was not a playlist: %s\", effective_url)\n            return JSONResponse(\n                content={\"error\": \"Upstream HLS playlist was invalid\"},\n                status_code=status.HTTP_502_BAD_GATEWAY,\n            )\n        return Response(\n            content=_rewrite_direct_hls_playlist(\n                payload,\n                effective_url,\n                referer,\n            ),\n            media_type=\"application/vnd.apple.mpegurl\",\n            headers={\"Cache-Control\": \"no-store\"},\n        )\n\n    return StreamingResponse(\n        response.aiter_bytes(chunk_size=64 * 1024),\n        media_type=media_type,\n        background=BackgroundTask(response.aclose),\n    )\n\n\n'''
backend = backend.replace(content_anchor, hls_route + content_anchor, 1)
backend_path.write_text(backend)
