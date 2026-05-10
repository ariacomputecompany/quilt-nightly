FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_SYSTEM_PYTHON=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY quilt_rlm.py /opt/quilt-rlm/quilt_rlm.py
COPY examples /opt/quilt-rlm/examples

RUN python -m pip install --upgrade pip setuptools wheel uv \
    && uv pip install --system rlms \
    && install -m 0755 /opt/quilt-rlm/quilt_rlm.py /usr/local/bin/quilt-rlm \
    && ln -sf /usr/local/bin/quilt-rlm /usr/bin/quilt-rlm \
    && python --version >/dev/null \
    && quilt-rlm doctor --json >/dev/null

WORKDIR /workspace

CMD ["/bin/bash"]
