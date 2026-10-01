# Contabo WhatsApp agents

OpenWA owns the WhatsApp session. Only one agent webhook should be active: Hermes or
agent-bridge with Command Code. Both acknowledge accepted `@me` prompts with 👾 and
label replies with the harness name. Typing is refreshed while working and cleared
afterwards; WhatsApp controls how self-chat presence appears on the phone.

The bridge image includes Command Code 1.69.0, the compiled bridge and its approval
hook. `/srv/agent-stack/bridge-data` persists Command Code authentication, workspace,
bridge configuration and chat sessions. It is writable by uid 1000; auth.json is mode
600. Shell/write/edit tools require a chat approval, with unanswered requests denied.

Build from an npm archive in a small build directory (not the whole source tree):

```sh
docker build -t agent-bridge:cmdc-20260930 \
  --build-arg BRIDGE_PACKAGE=/tmp/bridge-build/mayurathavale18-agent-bridge-0.1.1.tgz \
  /srv/agent-stack/bridge-build
docker save agent-bridge:cmdc-20260930 | k3s ctr images import -
kubectl -n agent-stack patch deployment agent-bridge \
  --patch-file /srv/agent-stack/bridge-build/cmdc-patch.yaml
```

On the server, select the agent without duplicate replies:

```sh
python3 /srv/agent-stack/bridge-build/select-harness.py status
python3 /srv/agent-stack/bridge-build/select-harness.py cmd
python3 /srv/agent-stack/bridge-build/select-harness.py hermes
```

Selecting `cmd` first makes a tiny no-tool model request. If authentication or quota
fails, routing stays unchanged. It does not enable extra/pay-as-you-go usage. The
bridge dashboard binds to localhost; use a tunnel to access it.

## Dashboard access

The dashboard runs in the bridge pod. The deployed systemd service forwards it
to the server's loopback interface and reconnects after pod restarts:

```sh
sudo cp deploy/k3s/agent-bridge-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-dashboard
```

From your computer, keep this SSH tunnel running:

```sh
ssh -N -L 18789:127.0.0.1:8789 -p 2222 -i ~/.ssh/id_ed25519_contabo root@<server-ip>
```

Open `http://127.0.0.1:18789`. The dashboard has no independent authentication;
keep both forwards on loopback and access it through SSH. Settings marked
`set by env` are controlled by deployment environment variables. Saved settings
apply after restarting the bridge.

### Subdomain with TLS and authentication

Use `agent.mayurathavale.com` with an A record pointing to `169.58.234.131`.
Public HTTPS uses port **443**; DNS records contain no port. Traefik forwards to
the internal dashboard service on **8789**. Do not expose 8789 directly.

Create `agent-dashboard-auth` in `agent-stack` with a `users` key containing
htpasswd entries, then apply `deploy/k3s/dashboard-ingress.yaml`. The existing
deployment reuses the owner's Jobwatch Basic Auth credential. Set
`DASHBOARD_HOST=0.0.0.0` in the pod to make it reachable by the service.
The ingress accepts HTTPS only and cert-manager uses `letsencrypt-prod`.
DNS must resolve to this server before certificate issuance can succeed.

### Codex and Claude Code

The image includes pinned Codex and Claude Code CLIs. Authenticate under the
persistent `/data` home as uid 1000, using native login flows, or securely provision
their auth files with owner 1000 and mode 600. Do not bake credentials into images.
Set `AGENT_BRIDGE_HARNESS=codex` or `claude-code` and restart after testing readiness.
The active webhook still points to the same bridge; `select-harness.py` controls
Hermes versus bridge routing, not which built-in bridge runner is selected.
To use dashboard selection, remove the environment pin for `AGENT_BRIDGE_HARNESS`.

The deployed package is built from this checkout; these changes have not been
published to npm. The previous bridge deployment is saved on the server at
`/srv/agent-stack/bridge-build/agent-bridge-before-cmdc.yaml`.

For Codex tool execution on a host with AppArmor, install the dedicated profile
before applying its pod patch (install on every node that can run this pod):

```sh
sudo install -m 644 deploy/apparmor/agent-bridge-codex /etc/apparmor.d/agent-bridge-codex
sudo apparmor_parser -r /etc/apparmor.d/agent-bridge-codex
kubectl -n agent-stack patch deployment agent-bridge --type=strategic --patch-file deploy/k3s/codex-sandbox-patch.yaml
kubectl -n agent-stack rollout status deployment/agent-bridge
```

This allows the nested sandbox's mount and pivot operations while keeping the
container non-root, dropping all capabilities, preventing privilege escalation,
and retaining containerd's /proc and /sys restrictions. Codex defaults to
read-only filesystem access. The deployment was verified with a real tool read
and a rejected write; do not replace this with a privileged container.

If the server's DNS resolver caches NXDOMAIN after a new record is added,
cert-manager's HTTP-01 self-check can use public resolvers through its controller
argument `--acme-http01-solver-nameservers=1.1.1.1:53,8.8.8.8:53`.