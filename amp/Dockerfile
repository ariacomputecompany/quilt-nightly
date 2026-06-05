FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY bin/amp-linux-x86_64-musl /usr/local/bin/amp
COPY quilt_amp.py /opt/quilt-amp/quilt_amp.py

RUN chmod 0755 /usr/local/bin/amp \
    && install -m 0755 /opt/quilt-amp/quilt_amp.py /usr/local/bin/quilt-amp \
    && ln -sf /usr/local/bin/quilt-amp /usr/bin/quilt-amp \
    && amp --version >/dev/null \
    && quilt-amp doctor --json >/dev/null

WORKDIR /workspace

CMD ["/bin/bash"]
