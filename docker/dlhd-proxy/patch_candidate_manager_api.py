from pathlib import Path

step_path = Path("dlhd_proxy/step_daddy.py")
text = step_path.read_text()

if "import asyncio\n" not in text:
    text = text.replace("import base64\n", "import asyncio\nimport base64\n", 1)

anchor = "    async def key(self, url: str, host: str):\n"
assert anchor in text, "StepDaddy key anchor changed"

methods = r'''    async def candidate_refs(self, channel_id: str):
        """Enumerate stable DaddyLive player/embed/source identities for a channel."""

        player_folders = ("stream", "watch", "cast", "plus", "player", "casting")

        async def scan_folder(folder: str):
            page_url = f"{self._base_url}/{folder}/stream-{channel_id}.php"
            try:
                response = await self._get(
                    page_url,
                    headers=self._headers(),
                    timeout=2.0,
                )
            except Exception:
                return []
            if response.status_code >= 400:
                return []

            matches = re.findall(
                r'<iframe[^>]+src=["\']([^"\']+)["\']',
                response.text,
                re.IGNORECASE,
            )
            refs = []
            for embed_index, match in enumerate(matches):
                player_url = urljoin(page_url, match)
                try:
                    player_response = await self._get(
                        player_url,
                        headers=self._headers(page_url),
                        timeout=2.0,
                    )
                except Exception:
                    continue
                if player_response.status_code >= 400:
                    continue
                sources = _extract_direct_hls_sources(player_response.text)
                for source_index, _source_url in enumerate(sources):
                    refs.append(
                        {
                            "family": folder,
                            "embed": embed_index,
                            "source": source_index,
                            "id": f"{folder}:{embed_index}:{source_index}",
                        }
                    )
            return refs

        batches = await asyncio.gather(
            *(scan_folder(folder) for folder in player_folders),
            return_exceptions=False,
        )
        out = []
        seen = set()
        for batch in batches:
            for row in batch:
                identity = row["id"]
                if identity in seen:
                    continue
                seen.add(identity)
                out.append(row)
        return out

    async def stream_candidate(
        self,
        channel_id: str,
        family: str,
        embed_index: int,
        source_index: int,
    ):
        """Resolve and media-probe one exact DaddyLive candidate identity."""

        player_folders = ("stream", "watch", "cast", "plus", "player", "casting")
        if family not in player_folders:
            raise ValueError("Unknown player family")
        if embed_index < 0 or source_index < 0:
            raise ValueError("Invalid candidate indexes")

        page_url = f"{self._base_url}/{family}/stream-{channel_id}.php"
        response = await self._get(
            page_url,
            headers=self._headers(),
            timeout=2.0,
        )
        if response.status_code >= 400:
            raise ValueError(f"Candidate page HTTP {response.status_code}")

        matches = re.findall(
            r'<iframe[^>]+src=["\']([^"\']+)["\']',
            response.text,
            re.IGNORECASE,
        )
        if embed_index >= len(matches):
            raise ValueError("Candidate embed disappeared")

        player_url = urljoin(page_url, matches[embed_index])
        player_response = await self._get(
            player_url,
            headers=self._headers(page_url),
            timeout=2.0,
        )
        if player_response.status_code >= 400:
            raise ValueError(f"Candidate player HTTP {player_response.status_code}")

        sources = _extract_direct_hls_sources(player_response.text)
        if source_index >= len(sources):
            raise ValueError("Candidate source disappeared")
        hls_url = sources[source_index]

        headers = self._headers(player_url)
        current_url = hls_url
        root_payload = None
        for _depth in range(3):
            hls_response = await self._get(
                current_url,
                headers=headers,
                timeout=2.0,
            )
            if hls_response.status_code >= 400:
                raise ValueError(f"Candidate playlist HTTP {hls_response.status_code}")
            payload = hls_response.text
            if not payload.lstrip().startswith("#EXTM3U"):
                raise ValueError("Candidate playlist invalid")
            if root_payload is None:
                root_payload = payload

            lines = [line.strip() for line in payload.splitlines() if line.strip()]
            if any(line.upper().startswith("#EXT-X-STREAM-INF") for line in lines):
                child = next((line for line in lines if not line.startswith("#")), None)
                if not child:
                    raise ValueError("Candidate master had no child")
                current_url = urljoin(current_url, child)
                continue

            segment = next((line for line in lines if not line.startswith("#")), None)
            if not segment:
                part = next(
                    (line for line in lines if line.upper().startswith("#EXT-X-PART:")),
                    None,
                )
                part_match = re.search(
                    r'URI=["\']([^"\']+)["\']',
                    part or "",
                    re.IGNORECASE,
                )
                segment = part_match.group(1) if part_match else None
            if not segment:
                raise ValueError("Candidate media playlist had no segment")

            segment_url = urljoin(current_url, segment)
            segment_response = await self._get(
                segment_url,
                headers={**headers, "Range": "bytes=0-4095"},
                timeout=2.0,
            )
            if segment_response.status_code >= 400:
                segment_response = await self._get(
                    segment_url,
                    headers=headers,
                    timeout=2.0,
                )
            if segment_response.status_code >= 400 or not segment_response.content:
                raise ValueError(
                    f"Candidate segment HTTP {segment_response.status_code}"
                )

            logger.info(
                "Validated DLHD candidate %s embed %s source %s for channel %s",
                family,
                embed_index + 1,
                source_index + 1,
                channel_id,
            )
            return _rewrite_direct_hls_playlist(
                root_payload,
                hls_url,
                player_url,
            )

        raise ValueError("Candidate playlist nesting exceeded")

'''
text = text.replace(anchor, methods + anchor, 1)
step_path.write_text(text)

backend_path = Path("dlhd_proxy/backend.py")
backend = backend_path.read_text()
stream_anchor = '@fastapi_app.get("/stream/{channel_id}.m3u8")\n'
assert stream_anchor in backend, "backend stream route anchor changed"

routes = r'''@fastapi_app.get("/candidates/{channel_id}")
async def stream_candidates(channel_id: str):
    try:
        candidates = await step_daddy.candidate_refs(channel_id)
        return {"channel_id": str(channel_id), "candidates": candidates}
    except Exception as exc:
        logger.exception("Candidate discovery failed for %s", channel_id)
        return JSONResponse(
            content={"error": str(exc)},
            status_code=status.HTTP_502_BAD_GATEWAY,
        )


@fastapi_app.get(
    "/candidate/{channel_id}/{family}/{embed_index}/{source_index}.m3u8"
)
async def stream_candidate(
    channel_id: str,
    family: str,
    embed_index: int,
    source_index: int,
):
    try:
        playlist_body = await step_daddy.stream_candidate(
            channel_id,
            family,
            embed_index,
            source_index,
        )
        return Response(
            content=playlist_body,
            media_type="application/vnd.apple.mpegurl",
            headers={
                "Cache-Control": "no-store",
                "X-DLHD-Candidate": f"{family}:{embed_index}:{source_index}",
            },
        )
    except ValueError as exc:
        logger.info(
            "Candidate unavailable for %s %s:%s:%s: %s",
            channel_id,
            family,
            embed_index,
            source_index,
            exc,
        )
        return JSONResponse(
            content={"error": str(exc)},
            status_code=status.HTTP_404_NOT_FOUND,
        )
    except Exception as exc:
        logger.exception("Candidate error for %s", channel_id)
        return JSONResponse(
            content={"error": str(exc)},
            status_code=status.HTTP_502_BAD_GATEWAY,
        )


'''
backend = backend.replace(stream_anchor, routes + stream_anchor, 1)
backend_path.write_text(backend)
