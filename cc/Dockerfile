FROM node:20-bookworm

ARG CLAUDE_CODE_VERSION=2.1.72

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    --fetch-retries=5 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=2000 \
    --fetch-retry-maxtimeout=120000 \
    && CLAUDE_BIN="$(command -v claude)" \
    && [ -n "${CLAUDE_BIN}" ] \
    && ln -sf "${CLAUDE_BIN}" /usr/local/bin/claude \
    && ln -sf "${CLAUDE_BIN}" /usr/bin/claude \
    && /usr/local/bin/claude --version >/dev/null \
    && /usr/bin/claude --version >/dev/null \
    && claude --version >/dev/null

WORKDIR /workspace

CMD ["/bin/bash"]
