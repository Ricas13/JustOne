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

helpers = '''def _extract_direct_hls_source(response_text: str) -> str | None:\n    \"\"\"Extract a base64-embedded direct HLS source from the DLHD player.\"\"\"\n\n    match = re.search(\n        r\"source\\s*:\\s*(?:window\\.)?atob\\(\\s*['\\\"]([^'\\\"]+)['\\\"]\\s*\\)\",\n        response_text,\n        re.IGNORECASE,\n    )\n    if not match:\n        return None\n\n    encoded = match.group(1)\n    try:\n        decoded = base64.b64decode(encoded + \"=\" * (-len(encoded) % 4)).decode(\"utf-8\").strip()\n    except Exception:\n        return None\n\n    if not decoded.startswith((\"http://\", \"https://\")):\n        return None\n    return decoded\n\n\ndef _rewrite_direct_hls_playlist(payload: str, playlist_url: str) -> str:\n    \"\"\"Proxy direct-HLS assets through the existing encrypted content route.\"\"\"\n\n    rewritten: list[str] = []\n    for raw_line in payload.splitlines():\n        line = raw_line.strip()\n\n        if line.startswith(\"#\") and \"URI=\" in line:\n            def replace_uri(match):\n                absolute = urljoin(playlist_url, match.group(2))\n                proxied = f\"{config.api_url}/content/{encrypt(absolute)}\"\n                return f\"{match.group(1)}{proxied}{match.group(3)}\"\n\n            line = re.sub(r\"(URI=['\\\"])(.*?)(['\\\"])\", replace_uri, line)\n            rewritten.append(line)\n            continue\n\n        if line and not line.startswith(\"#\"):\n            absolute = urljoin(playlist_url, line)\n            parsed = urlparse(absolute)\n            if _is_hls_path((parsed.path or \"\").lower()) or config.proxy_content:\n                line = f\"{config.api_url}/content/{encrypt(absolute)}\"\n\n        rewritten.append(line)\n\n    return \"\\n\".join(rewritten) + \"\\n\"\n\n\n'''
text = text.replace(helper_anchor, helper_anchor + helpers, 1)

legacy_anchor = '''        channel_key = re.compile(rf\"const\\s+{re.escape(key)}\\s*=\\s*\\\"(.*?)\\\";\").findall(source_response.text)[-1]\n\n        data = decode_bundle(source_response.text)\n'''
assert legacy_anchor in text, "upstream stream parser anchor changed"

replacement = '''        # New DLHD player: the HLS URL is embedded directly in a base64 atob()\n        # expression. Prefer it when present; retain the old auth flow below for\n        # older player hosts.\n        direct_hls_url = _extract_direct_hls_source(source_response.text)\n        if direct_hls_url:\n            direct_response = await self._get(\n                direct_hls_url,\n                headers=self._headers(source_url),\n            )\n            if direct_response.status_code >= 400:\n                raise ValueError(\n                    f\"Direct HLS source returned HTTP {direct_response.status_code}\"\n                )\n            if \"#EXTM3U\" not in direct_response.text[:256]:\n                raise ValueError(\"Direct HLS source did not return an HLS playlist\")\n            logger.info(\"Resolved channel %s through direct embedded HLS\", channel_id)\n            return _rewrite_direct_hls_playlist(direct_response.text, direct_hls_url)\n\n        channel_matches = re.compile(\n            rf\"const\\s+{re.escape(key)}\\s*=\\s*\\\"(.*?)\\\";\"\n        ).findall(source_response.text)\n        if not channel_matches:\n            raise ValueError(\"No supported DLHD player source found\")\n        channel_key = channel_matches[-1]\n\n        data = decode_bundle(source_response.text)\n'''
text = text.replace(legacy_anchor, replacement, 1)

path.write_text(text)
