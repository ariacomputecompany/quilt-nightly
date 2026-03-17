FROM node:20-bookworm

ARG CODEX_VERSION=0.115.0

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
    --fetch-retries=5 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=2000 \
    --fetch-retry-maxtimeout=120000 \
    && CODEX_BIN="$(command -v codex)" \
    && [ -n "${CODEX_BIN}" ] \
    && CODEX_REAL="$(readlink -f "${CODEX_BIN}")" \
    && [ -x "${CODEX_REAL}" ] \
    && if [ "${CODEX_REAL}" != "/usr/local/bin/codex" ]; then ln -sf "${CODEX_REAL}" /usr/local/bin/codex; fi \
    && if [ "${CODEX_REAL}" != "/usr/bin/codex" ]; then ln -sf "${CODEX_REAL}" /usr/bin/codex; fi \
    && /usr/local/bin/codex --version >/dev/null \
    && /usr/bin/codex --version >/dev/null \
    && codex --version >/dev/null

WORKDIR /workspace

CMD ["/bin/bash"]
