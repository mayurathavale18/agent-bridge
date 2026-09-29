# agent-bridge

[![CI](https://github.com/mayurathavale18/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mayurathavale18/agent-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-5b9dff.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.6-5b9dff)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-7bd88f)

One event contract. Many agent harnesses. Many chat channels.

A harness-agnostic bridge for driving coding agents (Command Code, Claude Code, Codex, Pi,
Hermes, or your own) from any chat medium — starting with WhatsApp. The bridge does not
implement an agent loop; it normalizes whatever a harness emits into one event language and
lets channels render it.

```
WhatsApp ──► OpenWA ──webhook──►  ┌──────────────────────────────┐        ┌─ cmd
                                  │           BRIDGE             │        ├─ claude
   CLI ─────────────────────────► │  normalize · route · approve │ ─────► ├─ codex
                                  │  queue · session · sandbox    │        ├─ http (any lang)
                                  └──────────────────────────────┘        └─ native plugin
```

The contract lives in [`docs/harness-spec.md`](docs/harness-spec.md).

## Status

This is the **contract skeleton**. It compiles, it runs, and the `cmd` adapter drives a real
Command Code headless run end to end. The WhatsApp channel, the config dashboard, the queue
and the approval transport are designed in the spec but not yet implemented — deliberately:
the contract is the part worth getting right first.

| Piece | State |
| --- | --- |
| Normalized event model (`AgentEvent`) | done |
| `AgentRunner` interface + capabilities | done |
| `harness.json` manifest + validation | done |
| `cmd` adapter (Command Code NDJSON) | done, verified live |
| `http` adapter (generic wire) | done |
| `mock` adapter (deterministic, no cost) | done |
| CLI channel | done |
| OpenWA / WhatsApp channel | done |
| Config dashboard (schema-driven) | done |
| Approval transport over chat | done |
| Per-chat queue (single-flight) | done |
| Session routing (resume across messages) | done — persists across restarts |

## Run it

Requires Node >= 22.6 (type stripping — no build step).

```bash
npm install          # only for typecheck; running needs no deps

npm run list         # show harnesses and their capabilities
npm run demo         # run the mock harness (no model, no cost)

# a real harness
node src/index.ts --harness cmd --workspace . --model claude-sonnet-5 "summarize this repo"

# any HTTP harness
node src/index.ts --harness http --url http://localhost:8787 "do the thing"

# load a plugin from a manifest
node src/index.ts --manifest examples/harness.cmd.json "say hi"

npm run typecheck
npm test
```

`cmd` runs in headless mode, which **blocks file writes and shell commands by default**.
Pass `--permission-mode accept-edits` (or `yolo`) only inside a sandboxed workspace.

On Windows the installed CLI is a `.cmd` shim, which cannot be executed without a shell —
and the bridge deliberately never uses a shell, because the prompt is untrusted input. Point
the adapter at the package's JavaScript entry instead:

```bash
node src/index.ts --harness cmd \
  --config binary="$(npm root -g)/command-code/dist/index.mjs" \
  "summarize this repo"
```

The adapter runs any `.js`/`.mjs`/`.cjs` config value through the current Node, so this works
identically on every platform.

## Drive it from WhatsApp

Start the channel, then point an OpenWA webhook at it (`message.received` only):

```bash
OPENWA_API_KEY=owa_k1_... \
OPENWA_WEBHOOK_SECRET=... \
AGENT_BRIDGE_HARNESS=cmd \
AGENT_BRIDGE_MODEL=gpt-6-luna \
npm run serve
```

| Env | Meaning |
| --- | --- |
| `OPENWA_API_KEY` | required — the gateway API key |
| `OPENWA_BASE_URL` | default `http://127.0.0.1:2785` |
| `OPENWA_WEBHOOK_SECRET` | HMAC secret; **unset disables signature verification** (warned at boot) |
| `OPENWA_SESSION_ID` | pin the sending session instead of trusting the payload |
| `AGENT_BRIDGE_HARNESS` | pins the active harness (`cmd` default), overriding the dashboard |
| `AGENT_BRIDGE_WORKSPACE` | working directory for runs (default cwd) |
| `AGENT_BRIDGE_CONFIG_FILE` | JSON file the dashboard writes (active harness + per-harness values) |
| `AGENT_BRIDGE_SESSION_FILE` | JSON file persisting chat → session, so a restart keeps the thread |
| `AGENT_BRIDGE_<ID>__<KEY>` | pins one harness setting, e.g. `AGENT_BRIDGE_CMD__MODEL=gpt-6-luna` |
| `AGENT_BRIDGE_APPROVAL_TIMEOUT_MS` | how long to wait for an approval reply (default `120000`) |
| `WA_PORT` / `WA_HOST` | default `8788` / `127.0.0.1` |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` | default `8789` / `127.0.0.1` |

Then message **yourself** in WhatsApp, tagging your own number (or writing `@me`):

```
@me list the repos in this workspace
```

The bridge replies in the self-chat with a `working...` message that it edits as tools run,
then replaces with the answer.

Four things keep this safe, all enforced in `src/channels/whatsapp/`:

1. **Signature** — every webhook must carry a valid `X-OpenWA-Signature` (HMAC-SHA256 over the raw body).
2. **Idempotency** — OpenWA retries; the `idempotencyKey` is deduped so a retry cannot run twice.
3. **Self-chat only** — `fromMe && from === to && !isGroup`. A message from anyone else is ignored outright.
4. **Mention-gated + echo guard** — a run needs a real self-mention (or `@me`); replies the bridge posts carry neither, so it can never trigger itself.

### Approvals from the chat

When a harness wants to do something destructive it emits `approval_request`; the run parks
and the chat message becomes:

```
approval needed: Run "git push --force" on main?
reply "yes" to approve, "no" to deny, or "cancel" to stop the run
```

Your reply is matched to the waiting run, delivered through `AgentRunner.respondApproval`, and
the run continues. Three deliberate behaviours, each covered by a test:

- **Ambiguous replies never decide.** Anything unrecognized re-prompts and the run stays parked —
  guessing on an approval is exactly how an unintended command runs.
- **Unanswered approvals deny.** After `AGENT_BRIDGE_APPROVAL_TIMEOUT_MS` the approval resolves to
  deny, so a forgotten prompt can never become a silent yes.
- **`cancel` denies *and* aborts** — the harness receives the deny and its `AbortSignal` fires, so
  a real harness kills the running child process.

**How it works for `cmd`** (`approvals: true`, or the dashboard's *Gate tools behind chat
approval*): Command Code's `PreToolUse` hook is the
gate. The adapter installs one into the workspace's `.commandcode/settings.json` for the run —
merging with whatever is already there and restoring the exact previous bytes afterwards — points
it at a loopback callback server, and each shell/write/edit call arrives in the chat as
`SHELL: rm -rf build` and waits for your answer. The hook **fails closed**: if the bridge is
unreachable it denies rather than allowing.

There are two independent gates, and this is the subtle part: headless mode denies shell/write/edit
outright *regardless of hooks*, so without lifting that, every "approve" would silently do nothing.
The adapter therefore applies `--yolo` **only after the hook is installed successfully** — if the
hook cannot be written, the blanket denial stays in force.

Any other harness can implement the same round-trip by implementing `respondApproval`
(`capabilities().approvals === true`); see the contract in `docs/harness-spec.md`.

### Conversation continuity

A chat keeps its context. Each run reports a session id, which is stored per chat and handed back
on the next message (`cmd --resume <id>`), so a second message continues the first:

```
you: @me remember the number 42
you: @me what number did I ask you to remember?      → 42
```

- `new` (or `/new`, `reset`) forgets the chat's session so the next message starts clean.
- `session` (or `/session`, `status`) reports the current session id.
- `AGENT_BRIDGE_SESSION_FILE` persists the map, so a restart does not lose the thread.

The session id is announced once, when it begins — after that, continuity is silent. A harness
whose `capabilities().resume` is false is never handed a session id; every message is a fresh run.

## The config dashboard

The bridge also serves a schema-driven config UI (default `http://127.0.0.1:8789`):

```bash
AGENT_BRIDGE_CONFIG_FILE=./data/config.json npm run serve
# open http://127.0.0.1:8789
```

Pick a harness and its form is generated from that manifest's `config` JSON Schema — no dashboard
code knows about models, binaries or timeouts. Add a property to a manifest and a control appears.

Settings resolve in one order: **manifest defaults < what you saved < environment**, so a container
or CI can pin a value regardless of the UI. When the environment pins a key the field is badged
`set by env` — a saved value that silently loses is the most confusing failure mode of this design,
so it is surfaced rather than hidden.

Harness and value changes apply on restart (the running runner is built once at boot); the header
reads `changed — restart to apply` while something is waiting.

A field left blank is saved as **unset**, not as an empty value — an untouched dropdown shows
`unset` and never pins a choice you did not make. Save writes the whole visible form, so a
manifest default you never touched is stored alongside your edit; that pins it if the plugin
later changes its own default. Sending only changed fields (merge instead of replace) is the
obvious refinement.

The dashboard is **unauthenticated and bound to loopback**. It exposes configuration — binding it
anywhere else is an explicit decision.

## Layout

```
src/core/                events.ts · runner.ts · manifest.ts · registry.ts · loader.ts · ndjson.ts · async-queue.ts · session-store.ts · config-store.ts · config-schema.ts
src/harnesses/           cmd.ts · http.ts · mock.ts · cmd-hook.ts · catalog.ts   (adapters)
src/harnesses/hooks/     cmd-approval-hook.mjs                      (PreToolUse gate)
src/dashboard/           server.ts · page.ts                        (schema-driven config UI)
src/channels/            cli.ts                                (channel)
src/channels/whatsapp/   channel.ts · client.ts · trigger.ts · renderer.ts · signature.ts · approval.ts · commands.ts · types.ts
src/index.ts             one-shot CLI
src/serve.ts             WhatsApp channel server
docs/                    harness-spec.md · hermes-integration.md   (contract · Hermes recon)
examples/                harness.cmd.json · harness.http.json
```

## Roadmap

1. **Hermes channel plugin** — recon done: see [`docs/hermes-integration.md`](docs/hermes-integration.md).
   Hermes already ships WhatsApp (Baileys + Cloud API), so this is not a gap in the usual sense —
   but a number already paired to OpenWA cannot also be used by Hermes' built-in adapter. The
   finding is that this ships as a **standalone Python plugin repo** (zero core changes), and that
   most of this bridge is redundant once Hermes is the target: the transferable artifact is the
   OpenWA transport, not the bridge.

## Design rules

- Model choice belongs to the harness, never the bridge. The bridge passes `--model`/`--config`
  through and lets each harness own it.
- The bridge is model- and vendor-agnostic: no model ids in core code.
- Channels never import harnesses; harnesses never import channels. Everything meets in the
  normalized event stream.
- Anything talking to a chat channel runs isolated, with capped egress and approval gates.

## Contributing

```bash
npm install --include=dev   # dev tooling only; running needs no deps
npm run typecheck
npm test
```

CI runs typecheck and the full suite on Node 22 and 24. Before opening a PR, please read
[`docs/harness-spec.md`](docs/harness-spec.md) — most changes are either a new adapter (implement
`AgentRunner`), a new channel (consume `AgentEvent`), or an additive evolution of the contract
(additive-only within a major version; consumers MUST ignore unknown event types).

Security-sensitive changes (anything touching the webhook path, the approval transport, or how an
untrusted prompt reaches a harness) should say so in the PR description.

## License

[MIT](LICENSE).
