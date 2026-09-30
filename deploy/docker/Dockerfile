# agent-bridge from the published npm package — no source build needed.
# The WhatsApp channel server (agent-bridge-serve) listens on WA_PORT (default 8788)
# for OpenWA webhook deliveries and drives whichever harness AGENT_BRIDGE_HARNESS selects.
FROM node:22-alpine

RUN npm install -g @mayurathavale18/agent-bridge \
 && npm cache clean --force

ENV WA_PORT=8788 \
    AGENT_BRIDGE_HARNESS=mock

# node:22-alpine ships a non-root `node` user
USER node
EXPOSE 8788
CMD ["agent-bridge-serve"]
