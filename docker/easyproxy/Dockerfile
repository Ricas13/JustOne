FROM python:3.12-slim-bookworm AS source

ARG EASYPROXY_REPO=https://github.com/realbestia1/EasyProxy.git
ARG EASYPROXY_REF=a1aacf13cff86c5d35cb47cf900c4aaa3b58ceb5

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone "${EASYPROXY_REPO}" easyproxy \
    && cd easyproxy \
    && git checkout --detach "${EASYPROXY_REF}" \
    && test -f extractors/dlstreams.py \
    && python -m py_compile app.py extractors/dlstreams.py

FROM python:3.12-slim-bookworm

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=7860 \
    CONFIG_DIR=/data

# ffmpeg is used by EasyProxy's media/DVR helpers. The maintained DLStreams
# extractor itself is browser-less, so Chromium/FlareSolverr are intentionally
# not bundled into this private JustOne runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=source /src/easyproxy/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip check \
    && rm -f /tmp/requirements.txt

COPY --from=source /src/easyproxy/ /app/
RUN mkdir -p /data \
    && python -m py_compile app.py extractors/dlstreams.py extractors/registry_resolver.py services/proxy.py \
    && python -c "from extractors.dlstreams import DLStreamsExtractor; print('DLStreamsExtractor import ok')"

EXPOSE 7860
VOLUME ["/data"]

# One aiohttp process owns the extractor sessions/cookies and persistent config.
CMD ["python", "app.py"]
