FROM python:3.11-slim

ARG UPSTREAM_REPO=https://github.com/amddeus/dlhd-proxy.git
ARG UPSTREAM_REF=d2c691c52976d85218d22c6addc0fcc6dd9a5593

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# We only need amddeus' FastAPI DLHD backend.  The upstream Dockerfile also
# compiles a Reflex frontend (reflex init/export), starts Caddy and Redis, none
# of which sits in JustOne's playback path.  Cloning the pinned source and
# running fastapi_app directly avoids that fragile frontend build step while
# retaining the upstream stream/auth/key/content implementation unchanged.
RUN git clone --filter=blob:none "${UPSTREAM_REPO}" /tmp/dlhd-proxy \
    && cd /tmp/dlhd-proxy \
    && git checkout --detach "${UPSTREAM_REF}" \
    && cp -a . /app/ \
    && rm -rf /app/.git /tmp/dlhd-proxy

RUN pip install --no-cache-dir -r requirements.txt "uvicorn==0.35.0"

ENV PORT=3000 \
    REFLEX_API_URL=http://dlhd-proxy:3000 \
    PROXY_CONTENT=TRUE \
    SOCKS5="" \
    TZ=UTC \
    GUIDE_UPDATE=03:00 \
    PYTHONUNBUFFERED=1

EXPOSE 3000

CMD ["sh", "-c", "exec uvicorn dlhd_proxy.backend:fastapi_app --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers --forwarded-allow-ips='*'"]
