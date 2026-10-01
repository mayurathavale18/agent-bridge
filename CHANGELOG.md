# Changelog

## 0.3.0 — 2026-10-02

- Add direct WhatsApp model catalogs and verified harness/model switching.
- Add named threads with independent harness history and restart persistence.
- Receive attachments and deliver workspace images/documents up to 10 MiB.
- Add numbered clarification replies tied to unique question messages for capable adapters.
- Add private context indexes and a ChatGPT, Claude and Command Code transcript importer.
- Preserve environment pins and retain the working adapter when readiness checks fail.

## 0.2.1 — 2026-10-02

- Preserve structured CLI failures instead of overwriting them with informational stderr.
- Decode Codex model errors and explain how to restore the default model.
- Do not persist or announce sessions created by failed first turns.
- Clarify Codex model configuration for ChatGPT logins.

## 0.2.0 — 2026-10-02

- Add a supervised dashboard Save & restart action that drains active WhatsApp work.
- Add Codex and Claude Code JSONL adapters with native permissions, tool progress and resume.
- Isolate WhatsApp sessions by harness while preserving existing cmd sessions.
- Add minimal setup and contribution guides, an authenticated TLS ingress and website workspace.
- Reject cross-origin dashboard writes and replace deployment credentials with placeholders.


All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project aims for
[Semantic Versioning](https://semver.org/).

## [0.1.0] — initial public release

### Added

- **The harness contract** (`docs/harness-spec.md`): `AgentRunner`, the normalized
  `AgentEvent` stream, `HarnessCapabilities`, and the `harness.json` plugin manifest whose
  `config` JSON Schema drives config UIs.
- **HTTP harness wire** — a language-agnostic `POST {url}/runs` NDJSON contract, so an agent
  written in any language is a first-class plugin.
- **Adapters**: Command Code (`cmd`, verified live against headless `cmdc`, including session
  resume), generic `http`, and a deterministic `mock`.
- **CLI channel** (`src/index.ts`) with `--list`, `--manifest`, `--config key=value`,
  `--session`, `--approvals`.
- **WhatsApp channel** (`src/channels/whatsapp/`) for OpenWA: HMAC-verified webhooks,
  idempotency-key dedupe, self-chat `@me` triggering with loop prevention (`EchoGuard`),
  per-chat single-flight queue, progress-by-message-edit, and a **chat approval transport**
  (`approval_request` → reply `yes`/`no`/`cancel`, timeout denies).
- **Session routing** (`src/core/session-store.ts`): per-chat `cmd --resume` continuity with
  optional JSON persistence across restarts.
- **Config dashboard** (`src/dashboard/`): schema-driven config UI over the harness catalog,
  with environment-pin badges and restart-pending signalling.
- 99 tests (unit + integration), zero runtime dependencies, no build step.
- **npm package** (`@mayurathavale18/agent-bridge`) with `agent-bridge` and
  `agent-bridge-serve` bins, shipping a compiled `dist/` (Node refuses type-stripping under
  `node_modules`, so the package cannot ship TypeScript).

### Security

- The WhatsApp webhook requires a valid `X-OpenWA-Signature` (HMAC-SHA256 over the raw body);
  without a configured secret the channel warns and refuses to gate.
- The adapter never spawns a shell with chat text: an untrusted prompt is never interpreted as
  a command. Command Code is driven through its JavaScript entry point on Windows because the
  installed `.cmd` shim cannot be exec'd without a shell.
- Harness capabilities are declared and checked — `respondApproval` is only wired when
  `capabilities().approvals` is true, and an approval a channel cannot answer is surfaced
  rather than silently dropped.
