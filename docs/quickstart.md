# Minimal setup

Node.js 22.6+ and an authenticated agent CLI are enough to test the bridge.
No Kubernetes, Docker, or WhatsApp account is required for this first step.

```sh
git clone https://github.com/mayurathavale18/agent-bridge.git
cd agent-bridge
npm ci
npm run build
```

Install only the harness you want:

```sh
npm install -g @openai/codex
codex login
node src/index.ts --harness codex "Describe this repository"

# Alternative: Claude Code >= 2.1.259
npm install -g @anthropic-ai/claude-code
claude auth login
node src/index.ts --harness claude-code "Describe this repository"
```

On Windows, Node cannot directly spawn npm `.cmd` launchers. Set the Codex
executable to its JavaScript entry point with
`--config binary=C:/path/to/node_modules/@openai/codex/bin/codex.js`.
Claude's native `claude.exe` works directly; an npm installation can use its
`@anthropic-ai/claude-code/cli.js` entry point in the same way.

Codex inherits its native CLI config. If a host-specific `config.toml` contains an
unavailable model, use `--config ignoreUserConfig=true` or choose a supported model
with `--model`. Login credentials remain available when user config is ignored.

## Permissions and continuity

| Harness | Default | Chat approvals | Resume |
| --- | --- | --- | --- |
| cmd | standard | Optional tool hook | Yes |
| codex | read-only sandbox | No; unapproved operations fail | Yes |
| claude-code | plan mode | No; prompts are denied | Yes |

Use `--config sandbox=workspace-write` for Codex workspace edits. Claude supports
`--config permissionMode=acceptEdits` for file edits, or `dontAsk` for operations
already allowed by native policy. Neither new adapter enables a permission bypass.
Native MCP settings belong to each CLI. Codex reports token usage; Claude reports
tokens and the CLI's cost estimate, which is cumulative when resuming.

The CLI prints a session ID. Continue it with `--session <id>` and the same harness
and workspace. WhatsApp sessions are stored separately for each harness.

## Connect an existing OpenWA session

Reuse the OpenWA session you already paired. Export the environment values below
(PowerShell: `$env:NAME="value"`; POSIX shell: `export NAME="value"`):

```text
OPENWA_BASE_URL=http://127.0.0.1:2785
OPENWA_API_KEY=<your-gateway-key>
OPENWA_WEBHOOK_SECRET=<your-webhook-signing-secret>
OPENWA_SESSION_ID=<your-existing-session-id>
OPENWA_SELF_JID=<your-phone-jid>,<your-lid>
AGENT_BRIDGE_HARNESS=codex
AGENT_BRIDGE_WORKSPACE=<absolute-workspace-path>
AGENT_BRIDGE_CONFIG_FILE=./data/config.json
AGENT_BRIDGE_SESSION_FILE=./data/sessions.json
```

Create `data/`, then run `npm run serve`. Configure one active OpenWA webhook
for `message.received` and `message.sent`, pointing to
`http://<bridge-host>:8788/webhook` with the same signing secret. Send
`@me describe this workspace` in your WhatsApp self-chat.

The dashboard is at `http://127.0.0.1:8789`. Select a harness, save settings, then
restart the bridge. Remove `AGENT_BRIDGE_HARNESS` if you want dashboard selection
to control the active harness; an environment value otherwise pins it.

For remote hosting, use [Contabo deployment and authenticated ingress](contabo.md).
Credentials stay in native CLI storage or process environment; never put them in
manifests, screenshots, Git, or the dashboard's config file.
