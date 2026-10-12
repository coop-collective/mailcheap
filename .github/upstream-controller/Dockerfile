FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.162.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force
USER node
WORKDIR /workspace
ENTRYPOINT ["codex"]
