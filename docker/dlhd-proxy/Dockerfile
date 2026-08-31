FROM python:3.11-slim

ARG UPSTREAM_REPO=https://github.com/amddeus/dlhd-proxy.git
ARG UPSTREAM_REF=d2c691c52976d85218d22c6addc0fcc6dd9a5593

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# We only need amddeus' FastAPI DLHD backend. The upstream Dockerfile also
# compiles a Reflex frontend (reflex init/export), starts Caddy and Redis, none
# of which sits in JustOne's playback path. Cloning the pinned source and
# running fastapi_app directly avoids that fragile frontend build step while
# retaining the upstream stream/auth/key/content implementation unchanged.
RUN git clone --filter=blob:none "${UPSTREAM_REPO}" /tmp/dlhd-proxy \
    && cd /tmp/dlhd-proxy \
    && git checkout --detach "${UPSTREAM_REF}" \
    && cp -a . /app/ \
    && rm -rf /app/.git /tmp/dlhd-proxy

# The pinned upstream release hard-codes daddylivestream.com. DLHD moves its
# public frontend periodically; JustOne already discovers its catalogue from
# dlstreams.st. Keep the upstream resolver implementation, but make that single
# origin configurable so a future domain move is an env change, not another
# application rebuild.
RUN python -c 'from pathlib import Path; p=Path("dlhd_proxy/step_daddy.py"); s=p.read_text(); s=s.replace("import json\n", "import json\nimport os\n", 1); old="self._base_url = \"https://daddylivestream.com\""; new="self._base_url = os.getenv(\"DLHD_BASE_URL\", \"https://dlstreams.st\").rstrip(\"/\")"; assert old in s, "upstream base-url anchor changed"; p.write_text(s.replace(old, new, 1))'

# DLHD's current player no longer exposes CHANNEL_KEY/auth.php/server_lookup.
# It embeds the live HLS source as source:window.atob(...). Apply a small local
# compatibility patch that supports that protocol first and retains the pinned
# upstream legacy auth flow as fallback.
COPY patch_upstream.py /tmp/patch_upstream.py
RUN python /tmp/patch_upstream.py && rm /tmp/patch_upstream.py

# Reflex 0.8.7 declares sqlmodel>=0.0.24,<0.1. A much newer SQLModel release
# now imports Pydantic APIs that are unavailable while Reflex applies its v1
# compatibility patch, so an unpinned install crashes even on plain import.
# Keep the dependency generation that Reflex 0.8.7 was released against.
RUN pip install --no-cache-dir -r requirements.txt "sqlmodel==0.0.24" "uvicorn==0.35.0"

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
