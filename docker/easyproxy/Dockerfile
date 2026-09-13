FROM python:3.11-slim

ARG EASYPROXY_REPO=https://github.com/domainus/EasyProxy-English.git
ARG EASYPROXY_REF=8a326aea8d24331182fe0d6012ac15237e780b30

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone "${EASYPROXY_REPO}" /tmp/easyproxy \
    && cd /tmp/easyproxy \
    && git checkout --detach "${EASYPROXY_REF}" \
    && rm -rf .git \
    && cp -a . /app/ \
    && rm -rf /tmp/easyproxy

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 7860

CMD ["gunicorn", "--bind", "0.0.0.0:7860", "--workers", "4", "--worker-class", "aiohttp.worker.GunicornWebWorker", "app:app"]
