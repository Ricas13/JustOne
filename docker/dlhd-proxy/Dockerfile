FROM python:3.11-slim

ARG UPSTREAM_REPO=https://github.com/amddeus/dlhd-proxy.git
ARG UPSTREAM_REF=d2c691c52976d85218d22c6addc0fcc6dd9a5593

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --filter=blob:none "${UPSTREAM_REPO}" /tmp/dlhd-proxy \
    && cd /tmp/dlhd-proxy \
    && git checkout --detach "${UPSTREAM_REF}" \
    && cp -a . /app/ \
    && rm -rf /app/.git /tmp/dlhd-proxy

RUN python -c 'from pathlib import Path; p=Path("dlhd_proxy/step_daddy.py"); s=p.read_text(); s=s.replace("import json\n", "import json\nimport os\n", 1); old="self._base_url = \"https://daddylivestream.com\""; new="self._base_url = os.getenv(\"DLHD_BASE_URL\", \"https://dlstreams.st\").rstrip(\"/\")"; assert old in s, "upstream base-url anchor changed"; p.write_text(s.replace(old, new, 1))'

COPY patch_upstream.py /tmp/patch_upstream.py
RUN python /tmp/patch_upstream.py && rm /tmp/patch_upstream.py
COPY patch_subtitle_hls.py /tmp/patch_subtitle_hls.py
RUN python /tmp/patch_subtitle_hls.py && rm /tmp/patch_subtitle_hls.py
COPY patch_player_fallback.py /tmp/patch_player_fallback.py
RUN python /tmp/patch_player_fallback.py && rm /tmp/patch_player_fallback.py
COPY patch_secondary_players.py /tmp/patch_secondary_players.py
RUN python /tmp/patch_secondary_players.py && rm /tmp/patch_secondary_players.py
COPY patch_fast_tune.py /tmp/patch_fast_tune.py
RUN python /tmp/patch_fast_tune.py && rm /tmp/patch_fast_tune.py
COPY patch_candidate_manager_api.py /tmp/patch_candidate_manager_api.py
RUN python /tmp/patch_candidate_manager_api.py && rm /tmp/patch_candidate_manager_api.py

RUN pip install --no-cache-dir -r requirements.txt "sqlmodel==0.0.24" "uvicorn==0.35.0"

COPY test_secondary_players.py /tmp/test_secondary_players.py
COPY test_candidate_manager_api.py /tmp/test_candidate_manager_api.py
RUN PYTHONPATH=/app DLHD_BASE_URL=https://example.invalid \
    python /tmp/test_secondary_players.py \
    && python /tmp/test_candidate_manager_api.py \
    && rm /tmp/test_secondary_players.py /tmp/test_candidate_manager_api.py

ENV PORT=3000 \
    REFLEX_API_URL=http://dlhd-proxy:3000 \
    DLHD_BASE_URL=https://dlstreams.st \
    PROXY_CONTENT=TRUE \
    SOCKS5="" \
    TZ=UTC \
    GUIDE_UPDATE=03:00 \
    PYTHONUNBUFFERED=1

EXPOSE 3000

CMD ["sh", "-c", "exec uvicorn dlhd_proxy.backend:fastapi_app --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers --forwarded-allow-ips='*'"]
