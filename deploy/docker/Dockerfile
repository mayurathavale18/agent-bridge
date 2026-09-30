# agent-bridge from the published npm package — no source build needed.
# The WhatsApp channel server (agent-bridge-serve) listens on WA_PORT (default 8788)
# for OpenWA webhook deliveries and drives whichever harness AGENT_BRIDGE_HARNESS selects.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Use the registry package by default, or an uploaded npm pack archive for local changes.
ARG BRIDGE_PACKAGE=@mayurathavale18/agent-bridge
COPY *.tgz /tmp/bridge-build/
RUN npm install -g "${BRIDGE_PACKAGE}" command-code@1.69.0 \
 && rm -rf /tmp/bridge-build \
 && npm cache clean --force

ENV WA_PORT=8788 \
    WA_HOST=0.0.0.0 \
    AGENT_BRIDGE_HARNESS=cmd

# node:22-alpine ships a non-root `node` user
USER node
EXPOSE 8788
CMD ["agent-bridge-serve"]
