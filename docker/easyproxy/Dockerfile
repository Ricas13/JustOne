FROM python:3.11-slim AS source

ARG EASYPROXY_REPO=https://github.com/domainus/EasyProxy-English.git
ARG EASYPROXY_REF=8a326aea8d24331182fe0d6012ac15237e780b30

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone "${EASYPROXY_REPO}" easyproxy \
    && cd easyproxy \
    && git checkout --detach "${EASYPROXY_REF}" \
    && rm -rf .git

COPY patch_easyproxy.py /tmp/patch_easyproxy.py
RUN python /tmp/patch_easyproxy.py /src/easyproxy \
    && python -m py_compile /src/easyproxy/app.py /src/easyproxy/dlhd_extractor.py

FROM python:3.11-slim

WORKDIR /app

COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock \
    && pip check \
    && rm -f /tmp/requirements.lock

COPY --from=source /src/easyproxy/ /app/
RUN mkdir -p /app/data \
    && python -m py_compile app.py dlhd_extractor.py vavoo_extractor.py playlist_builder.py

EXPOSE 7860

# One async worker avoids multiple processes racing EasyProxy's file-backed
# DLHD cache. aiohttp still handles concurrent HLS requests in that worker.
CMD ["gunicorn", "--bind", "0.0.0.0:7860", "--workers", "1", "--worker-class", "aiohttp.worker.GunicornWebWorker", "app:app"]
