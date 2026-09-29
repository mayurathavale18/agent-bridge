# Recon: contributing an OpenWA channel to Hermes Agent

Findings from reading Hermes Agent's (Nous Research, MIT, Python) gateway and plugin
documentation. Sources at the bottom.

## Headline findings

1. **Hermes already ships WhatsApp** — twice: a Baileys-based bridge and the WhatsApp Cloud
   API. Images, files, typing and streaming are supported; no voice, reactions or threads.
2. **An OpenWA channel is still not redundant**, for one concrete reason: *you cannot run two
   WhatsApp Web sessions against the same number.* If a number is already paired to OpenWA,
   Hermes' built-in Baileys adapter cannot also use it. An OpenWA-backed adapter lets Hermes
   front the **existing** OpenWA session rather than forcing a second pairing.
3. **This must ship as a standalone plugin repo, not a core PR.** Hermes' contributing policy:
   plugins integrating "someone else's product or project … are built and distributed as
   standalone plugin repos, not merged into `NousResearch/hermes-agent`." That is a
   coupling/ownership decision, not a quality bar.
4. **A platform plugin needs zero core changes** — `ctx.register_platform(...)`, dropped into
   `~/.hermes/plugins/<name>/`. No fork, no 20-file checklist.
5. **Relay is the wrong path here.** Hermes Relay fronts platforms through a *hosted or shared*
   connector that owns the credentials; the docs say plainly: *"If you run your own bots
   directly, use the native platform adapters instead."* OpenWA is self-hosted → native plugin.
6. **Target language is Python.** A platform adapter extends `BasePlatformAdapter` and runs
   in-process with Hermes. Our TypeScript bridge is a *reference*, not reusable code.

## The contract a channel must implement

```
~/.hermes/plugins/openwa/
├── plugin.yaml     # name, label, kind: platform, requires_env
└── adapter.py      # OpenWaAdapter(BasePlatformAdapter) + register(ctx)
```

**Adapter class** (`gateway/platforms/base.py`):

| Member | Requirement |
| --- | --- |
| `__init__(self, config: PlatformConfig)` | `super().__init__(config, Platform("openwa"))` |
| `async connect(self, *, is_reconnect: bool = False) -> bool` | Start the webhook listener; verify the OpenWA session; `self._mark_connected()` |
| `async disconnect(self) -> None` | `self._mark_disconnected()` |
| `async send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult` | `POST /api/sessions/{id}/messages/send-text`; return `SendResult(success, message_id)` |
| `async send_typing(self, chat_id)` | optional; OpenWA has a typing indicator |
| `async get_chat_info(self, chat_id)` | optional |
| `async _keep_typing(...)` | optional override for platform-specific slow-LLM UX |

**Inbound**: build a `MessageEvent` with `self.build_source(...)` and hand it over with
`await self.handle_message(event)` — the base class routes it into the gateway runner.

**Module level**: `check_requirements()`, `validate_config(config)`, `_env_enablement()`, and
`register(ctx)` calling `ctx.register_platform(...)` with `adapter_factory`, `check_fn`,
`required_env`, `allowed_users_env`, `allow_all_env`, `max_message_length`, `platform_hint`,
`cron_deliver_env_var`, `standalone_sender_fn`.

Reference implementations to copy: `plugins/platforms/irc/` (stdlib-only, complete),
`plugins/platforms/wecom/callback_adapter.py` (webhook + ack-immediately pattern — ours),
`plugins/platforms/line/adapter.py` (edit-based progressive UX).

## What transfers from this repo — and what Hermes already does

This is the important part. Most of the bridge is **redundant** if Hermes is the target.

| Piece here | Verdict |
| --- | --- |
| `channels/whatsapp/client.ts` (OpenWA REST) | **Reusable** — becomes `send()` + the edit call behind streaming |
| `channels/whatsapp/signature.ts` (HMAC over raw body) | **Reusable** — the adapter's webhook route |
| `channels/whatsapp/renderer.ts` (chunking) | Replaced by `max_message_length=...` and Hermes' smart chunking |
| `channels/whatsapp/trigger.ts` (`@me` self-chat) | Partially — Hermes has allowlists, DM pairing and `require_mention` |
| `core/runner.ts` + `harnesses/` (cmd/claude/codex adapters) | **Not needed** — Hermes *is* the agent |
| `core/events.ts` (`AgentEvent`) | **Not needed** — Hermes has its own gateway event model |
| `core/manifest.ts` + `catalog.ts` (config schemas) | Superseded by `plugin.yaml` `config_schema` → Desktop settings form |
| `core/session-store.ts` (resume across messages) | Superseded — built-in per-chat sessions, `/new`, `/resume`, `/sessions` |
| `channels/whatsapp/approval.ts` + `cmd-approval-hook.mjs` | Superseded — built-in `/approve` `/deny`, native prompt buttons, and `pre_tool_call` returning `{"action": "approve"}` |
| `dashboard/` (schema-driven config UI) | Superseded by the Desktop Plugins tab, driven by `config_schema` |
| `core/async-queue.ts` | n/a (Python asyncio) |

So the transferable artifact is the **OpenWA transport** — roughly three files' worth of logic
rendered as one ~200-line Python adapter — not the bridge.

## Concrete adapter sketch

```python
# adapter.py
from gateway.platforms._shared import extra_or_secret, get_scoped_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator
from gateway.config import Platform, PlatformConfig

class OpenWaAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("openwa"))
        self.base_url = extra_or_secret(config.extra, "base_url", "OPENWA_BASE_URL")
        self.api_key = extra_or_secret(config.extra, "api_key", "OPENWA_API_KEY")
        self.secret = extra_or_secret(config.extra, "webhook_secret", "OPENWA_WEBHOOK_SECRET")
        self.session_id = extra_or_secret(config.extra, "session_id", "OPENWA_SESSION_ID")
        self._dedup = MessageDeduplicator(ttl_seconds=600)

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # aiohttp server for POST /webhook; verify HMAC over the RAW body against self.secret;
        # ACK 200 first (OpenWA retries a slow webhook), then hand the envelope to the queue.
        ...

    async def _on_webhook(self, envelope):
        if envelope["event"] != "message.received":
            return
        if self._dedup.is_duplicate(envelope.get("idempotencyKey") or envelope["data"]["id"]):
            return
        data = envelope["data"]
        event = MessageEvent(
            text=data["body"],
            message_type=MessageType.TEXT,
            source=self.build_source(chat_id=data["chatId"], chat_name=data["chatId"],
                                     chat_type="group" if data["isGroup"] else "dm",
                                     user_id=data["from"], user_name=data.get("author")),
            message_id=data["id"],
        )
        await self.handle_message(event)

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        r = await self._post(f"/api/sessions/{self.session_id}/messages/send-text",
                             {"chatId": chat_id, "text": content})
        return SendResult(success=True, message_id=r["messageId"])

def register(ctx):
    ctx.register_platform(
        name="openwa", label="OpenWA (WhatsApp)",
        adapter_factory=OpenWaAdapter,
        check_fn=lambda: bool(get_scoped_secret("OPENWA_BASE_URL")),
        required_env=["OPENWA_BASE_URL", "OPENWA_API_KEY"],
        allowed_users_env="OPENWA_ALLOWED_USERS",
        allow_all_env="OPENWA_ALLOW_ALL_USERS",
        max_message_length=4096,
        env_enablement_fn=..., cron_deliver_env_var="OPENWA_HOME_CHANNEL",
        emoji="💬",
        platform_hint="You are chatting via WhatsApp through an OpenWA gateway. No markdown tables; keep replies short.",
    )
```

```yaml
# plugin.yaml
name: openwa-platform
label: OpenWA (WhatsApp)
kind: platform
version: 0.1.0
description: Front an existing OpenWA session in Hermes without re-pairing the number
requires_env:
  - name: OPENWA_BASE_URL
    description: "OpenWA origin, e.g. http://127.0.0.1:2785"
    prompt: "OpenWA base URL"
  - name: OPENWA_API_KEY
    description: "Gateway API key (data/.api-key or the dashboard)"
    password: true
  - name: OPENWA_WEBHOOK_SECRET
    description: "HMAC secret configured on the OpenWA webhook"
    password: true
optional_env:
  - name: OPENWA_SESSION_ID
    description: "Session to send from (defaults to the payload's sessionId)"
  - name: OPENWA_ALLOWED_USERS
    description: "Comma-separated JIDs allowed to talk to the bot"
```

## Details worth getting right

- **Ack immediately, then work.** OpenWA retries a webhook that does not answer promptly (its
  delivery timeout is 10s). This is the documented `wecom/callback_adapter.py` pattern.
- **Verify the HMAC over the raw bytes**, not re-serialized JSON — OpenWA signs
  `sha256=HMAC_SHA256(secret, rawBody)`.
- **Dedupe on `idempotencyKey`** via `MessageDeduplicator`; the gateway copies live IDs across
  adapter reconnects, so a replay right after a reconnect is still dropped.
- **Streaming via edits.** WhatsApp is listed as streaming-capable, and Hermes'
  `tool_progress_grouping: accumulate` edits one bubble in place — that is the `/messages/edit`
  call our channel already uses.
- **Token lock.** Two Hermes profiles pointed at one OpenWA session would fight over the same
  linked device: use `acquire_scoped_lock("openwa", session_id)` in `connect()`.
- **The 24-hour rule does not apply.** Hermes documents "WhatsApp marks a session inactive after
  24h, after which only template messages are accepted" — that is a **Cloud API** constraint. A
  linked device (whatsapp-web.js / OpenWA) is not subject to it.
- **Authorization is Hermes' job, not ours.** Its gateway denies everyone not allowlisted or
  DM-paired by default. Our self-chat `@me` trigger is interesting but unusual here — Hermes'
  model is user IDs plus `require_mention`, so reuse its gating rather than inventing our own.

## Suggested next step

Standalone repo `hermes-openwa` with `plugin.yaml` + `adapter.py` (+ a couple of tests modelled
on `tests/gateway/`), installed by dropping it into `~/.hermes/plugins/openwa/`. Promote it in
the Nous Research Discord `#plugins-skills-and-skins` channel per CONTRIBUTING. Zero core files
touched, so the whole thing is reviewable and reversible on its own.

## Sources

- [Messaging Gateway — Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- [Build a Hermes Plugin — Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [Adding a Platform Adapter — Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters)
- [Hermes Relay — Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/relay)
- [NousResearch/hermes-agent — GitHub](https://github.com/nousresearch/hermes-agent)
