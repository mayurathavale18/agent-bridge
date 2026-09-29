# The Harness Contract

Every agent harness — in-process or out-of-process — speaks the same two things: a small
capability record and a stream of normalized events. Channels only ever see the events.
This separation is the whole point: a channel never knows which harness is behind it, and a
harness never knows which chat medium it is talking to.

```
        channel (whatsapp, cli, …)          bridge                    harness (cmd, http, …)
        ─────────────────────────           ──────                    ──────────────────────
        renders AgentEvent  ◄──────────  normalizes + routes  ──────►  emits AgentEvent
```

---

## 1. `AgentRunner`

```ts
interface AgentRunner {
  readonly id: string;
  capabilities(): HarnessCapabilities;
  run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  respondApproval?(approvalId: string, decision: 'approve' | 'deny', note?: string): Promise<void>;
}
```

Rules:

- `run` MUST yield **exactly one terminal `done` event, last** — including on error and on
  abort. A consumer that sees the iterator end without a `done` may treat the run as failed.
- `run` MUST respect `signal`: on abort, stop work and still yield a `done`.
- `respondApproval` is required **only** when `capabilities().approvals` is `true`.
- Unknown/extra fields are ignored by consumers, so harnesses can evolve additively.

### Approvals (the round-trip)

An approval is a blocking question from the harness. The contract fixes the ordering so both
sides agree on who waits for whom:

1. The harness yields `approval_request` and suspends its run.
2. The channel surfaces `prompt` and waits for the operator.
3. The channel calls `respondApproval(id, decision, note?)`.
4. The harness resumes and keeps yielding events, ending with `done` as usual.

**Requirements on the harness**

- `respondApproval` MUST be safe to call *before* the run has parked. A channel answers the
  instant the human replies, which can race the harness reaching its own await — store the
  decision if no waiter exists yet, rather than dropping it.
- A `deny` MUST leave the harness able to finish cleanly with a `done` event. Never hang.
- `approve` is *permission, not instruction*: the harness still owns what it does next.
- A stored decision MUST be consumed once; a second `respondApproval` for the same id is a
  no-op or an error, never a second execution.

**Requirements on the channel**

- An ambiguous reply MUST NOT decide — re-prompt and leave the run parked.
- An unanswered approval MUST resolve to `deny` on timeout. Silence is never consent.
- `cancel` MAY abort the run in addition to denying.

## 2. `HarnessCapabilities`

Declare honestly — a channel that assumes `streaming: true` from a harness that only emits
a final answer will appear frozen until the run ends.

| Flag | Meaning |
| --- | --- |
| `streaming` | Emits `text`/`tool_*` events during the run, not just at the end. |
| `resume` | Can continue a previous run given a `sessionId`. |
| `approvals` | Emits `approval_request` and implements `respondApproval`. |
| `nativeMcp` | Brings its own tool servers; the bridge need not inject any. |
| `reportsCost` | Emits token/cost `usage` events. |
| `models?` | Optional advertised model ids for the config UI. |

## 3. `AgentEvent` — the normalized stream

| `type` | Payload | Notes |
| --- | --- | --- |
| `text` | `text` | May repeat. Concatenation is not guaranteed complete — prefer `done.text`. |
| `tool_start` | `name`, `detail?`, `toolCallId?` | `detail` should be a human-readable one-liner. |
| `tool_end` | `name`, `detail?`, `ok?`, `toolCallId?` | `ok: false` means the tool errored. |
| `approval_request` | `id`, `prompt`, `options?` | Only when `approvals` is true. |
| `artifact` | `path`, `mime` | A file the channel should deliver. |
| `usage` | `inputTokens?`, `outputTokens?`, `costUsd?` | Emit as it becomes known. |
| `error` | `message` | Non-fatal; the run may still succeed. |
| `done` | `exitCode`, `text`, `sessionId?`, `stopReason?` | Terminal, exactly once, last. |

`done.text` is the **authoritative** final answer. `sessionId`, when present, is the handle a
channel stores to resume the conversation on the next message.

## 4. `harness.json` — the plugin manifest

```json
{
  "id": "cmd",
  "name": "Command Code",
  "version": "1.0.0",
  "kind": "native",
  "entry": "../src/harnesses/cmd.ts",
  "capabilities": { "streaming": true, "resume": true, "approvals": false, "nativeMcp": true, "reportsCost": true },
  "config": {
    "type": "object",
    "properties": {
      "model": { "type": "string", "title": "Model", "description": "Model id passed to the harness." },
      "maxTurns": { "type": "number", "default": 100 },
      "permissionMode": { "type": "string", "enum": ["standard", "plan", "accept-edits", "yolo"], "default": "standard" }
    }
  }
}
```

- `kind: "native"` — `entry` is a module (resolved relative to the manifest) that exports
  `createRunner(config: Record<string, unknown>): AgentRunner`.
- `kind: "http"` — `url` is the base URL of a service implementing §5.
- `config` is a JSON Schema. **The dashboard renders the settings form from this schema**, so
  adding a setting is a manifest change, not a UI change. Environment variables use the same
  keys (§6).

## 5. HTTP harness wire (any language)

A harness that is not Node can still be a first-class plugin. Implement one endpoint:

```
POST {url}/runs
Content-Type: application/json
Accept: application/x-ndjson

{ "prompt": "…", "workspace": "/abs/path", "sessionId": "…?" , "config": { … } }
```

Respond `200` with `application/x-ndjson`: **one `AgentEvent` JSON object per line**, ending
with a `done` line. The bridge streams lines through as they arrive, so a slow harness still
produces live progress.

```
{"type":"text","text":"looking at the repo…"}
{"type":"tool_start","name":"grep","detail":"TODO"}
{"type":"done","exitCode":0,"text":"found 3 TODOs"}
```

Any non-2xx status is surfaced as an `error` event. Malformed lines are skipped, not fatal.

## 6. Configuration precedence

One set of keys, three front-ends, resolved lowest-wins:

1. **Environment** (highest) — `AGENT_BRIDGE_<HARNESS_ID>__<KEY>`, e.g. `AGENT_BRIDGE_CMD__MODEL`.
   Derive the name from the manifest's `config` schema: uppercase, non-alphanumerics to `_`, and
   camelCase boundaries to `_` (`maxTurns` -> `MAX_TURNS`). A container or CI pins a value here.
2. **Saved config** — what the schema-driven dashboard wrote (the `config` front-end).
3. **Manifest defaults** (lowest) — the `default` on each property.

The dashboard renders its form from the `config` schema and MUST mark any key the environment is
pinning, so a saved value that loses to an env var is explained rather than silently ignored.

Secrets (API keys) are **never** placed in harness `config`. They are injected as environment
variables on the run request (`RunRequest.env`) and never logged or echoed back.

## 7. Versioning

- `AgentEvent` and `HarnessCapabilities` are additive-only within a major version.
- Consumers MUST ignore unknown event types and unknown fields (this is why the `cmd` adapter
  drops unrecognized frames rather than failing).
- A harness declares the contract version it targets in its manifest `version`; the bridge
  refuses a manifest whose major exceeds the contract's major.

## 8. Security requirements for harnesses

These are not optional for anything talking to a chat channel:

- **Assume the prompt is untrusted.** A message may be attacker-controlled (account takeover,
  forwarded content, prompt injection from anything the harness reads).
- **Run in isolation.** Execute inside a container or ephemeral worktree; never with the
  operator's full credentials or unconstrained host filesystem access.
- **Cap egress.** Keep read tools (email, web) separate from write/shell, and allow-list
  outbound destinations — that is what stops a poisoned input from exfiltrating.
- **Gate destructive actions.** Anything irreversible should surface as an `approval_request`
  rather than run unattended.
- **Never trust harness output as a command.** The bridge treats text as data for the user,
  not as instructions to execute.
