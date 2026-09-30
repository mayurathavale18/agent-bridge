#!/usr/bin/env bash
# Migrate the WhatsApp session from the Windows OpenWA container to the k3s OpenWA.
#
# Run ON THE WINDOWS MACHINE (phase 1), then ON THE SERVER (phase 2).
#
# Phase 1 (Windows, from %LOCALAPPDATA%\hermes\..\OpenWA — the compose bind mount ./data):
#   docker stop openwa-api                     # the SAME session must not run on two clients
#   tar -czf openwa-session.tgz -C .\data .
#   scp -P 2222 -i %USERPROFILE%\.ssh\id_ed25519_contabo openwa-session.tgz root@169.58.234.131:/srv/agent-stack/
#
# Phase 2 (server, this script):
set -euo pipefail
K="k3s kubectl"
SESSION_TGZ="${1:-/srv/agent-stack/openwa-session.tgz}"
DATA_DIR="/srv/agent-stack/openwa"

[ -f "$SESSION_TGZ" ] || { echo "usage: $0 /path/to/openwa-session.tgz"; exit 1; }

mkdir -p "$DATA_DIR"
tar -xzf "$SESSION_TGZ" -C "$DATA_DIR"
chown -R 1000:1000 "$DATA_DIR"

$K apply -f "$(dirname "$0")/openwa.yaml"

$K -n agent-stack rollout status deploy/openwa --timeout=180s
$K -n agent-stack get pods -o wide

echo "--- register the webhook against agent-bridge (in-cluster) ---"
SESSION_ID="$($K -n agent-stack exec deploy/openwa -- sh -c 'cat /app/data/.api-key 2>/dev/null' || true)"
echo "Get the session id from the OpenWA dashboard, then:"
echo "  curl -X POST http://openwa.agent-stack.svc:2785/api/sessions/<SESSION_ID>/webhooks \\"
echo "    -H 'X-API-Key: <OPENWA_API_KEY>' -H 'Content-Type: application/json' \\"
echo "    -d '{\"url\":\"http://agent-bridge.agent-stack.svc:8788/webhook\",\"events\":[\"message.received\",\"message.sent\"],\"secret\":\"<OPENWA_WEBHOOK_SECRET>\"}'"
