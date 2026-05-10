FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG AEGIS_REPO_URL=https://github.com/ariacomputecompany/aegis.git
ARG AEGIS_GIT_REF=linux

ENV PATH=/root/.cargo/bin:/root/.local/bin:${PATH} \
    CARGO_HOME=/root/.cargo \
    RUSTUP_HOME=/root/.rustup \
    AEGIS_HOME=/root/.aegis \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        npm \
        python3 \
        python3-pip \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal \
    && rustup default stable

WORKDIR /opt

RUN git clone --branch "${AEGIS_GIT_REF}" --depth 1 "${AEGIS_REPO_URL}" aegis-src

WORKDIR /opt/aegis-src

RUN bash scripts/bootstrap_linux_native.sh \
    && bash install.sh

COPY quilt_aegis.py /usr/local/bin/quilt-aegis

RUN chmod 0755 /usr/local/bin/quilt-aegis \
    && aegis usage >/dev/null \
    && quilt-aegis doctor --json >/dev/null

WORKDIR /workspace

CMD ["/bin/bash"]
