# WhatsApp controls and private context

Prefix each command with `@me` in your WhatsApp self chat. Commands run directly in
the bridge, so listing models does not spend a model turn.

| Command | Behavior |
| --- | --- |
| `/help` | Show commands |
| `/models` | Read the native CLI catalog; account access can differ |
| `/model <id>` | Verify the model with a short request, then save and apply |
| `/model default` | Clear the override and verify the CLI default |
| `/model` | Show selected alias and the model ID reported by the running CLI |
| `/mode` | Show permission mode |
| `/mode plan` | Read-only planning |
| `/mode write` | Accept edits; keep other permission restrictions |
| `/mode ask` | Send native permission requests through WhatsApp (Claude/Command Code) |
| `/harnesses` | List installed bridge adapters |
| `/harness <id>` | Verify and select an adapter |
| `/new <name>` | Create and select a named thread |
| `/threads` | List this harness's threads |
| `/use <name>` | Resume a thread, including `default` |
| `/new` | Forget the selected thread's session and start fresh |
| `/session` | Show the selected native session ID |
| `/send <path>` | Deliver a workspace file, up to 10 MiB |

Model selection is saved per harness and applies to its next turn. Thread histories
are separate for each harness. Environment-pinned settings cannot be overridden by
chat commands. Switching adapters verifies the saved configuration before activation;
missing login, quota and unsupported models leave the previous adapter running.
The dashboard's existing Save & restart action applies other configuration changes.

Claude maps plan/write/ask to `plan`/`acceptEdits`/`manual`; its dashboard permission
dropdown offers the same native settings. Command Code ask mode gates tools with
the existing approval hook. Codex supports plan/write through its read-only/workspace-write
sandbox; ask mode is rejected because a Codex chat approval transport is not implemented.
Mode changes apply to the next turn, keep the selected thread, and respect environment pins.

Command Code uses `cmdc --list-models`; Codex reads its native `models_cache.json`;
Claude Code reads the aliases advertised by its installed CLI help. These catalogs
are not promises of account entitlement. Mock has no model; HTTP adapters can advertise
`capabilities.models`, otherwise discovery is unavailable.

## Files

Send an image or document with `@me` in its caption. The bridge saves it under
`attachments/<unique-id>/` and passes its path to the agent. Codex images also use
the CLI image input. Other files need the native harness's file-reading tools.
When OpenWA omits a large payload, the bridge reports it rather than claiming to
have read the file. Files are not deleted automatically; the private workspace owner
controls retention.

Harnesses can emit an `artifact` event for automatic delivery. For native CLI output
that only names a file, use `/send <path>`. Outgoing files must resolve inside the
workspace; hidden paths are rejected. Do not put credentials in deliverable folders.

## Clarifications and links

Harnesses with a native reply transport may emit `choice_request` and implement
`respondChoice`. The bridge sends numbered text options. Reply to the question's
WhatsApp message with its option number, or use `@me /choose <question-id> <number>`.
The same running turn receives the option ID; unrelated/stale question IDs are rejected.
Questions expire using the approval timeout; restart cancels pending questions.
Tool approvals remain a separate yes/no flow.

Codex and Claude Code headless adapters do not expose a native clarification transport.
For their ordinary questions, reply with `@me <answer>` to continue the selected thread.
Native WhatsApp buttons/lists are not enabled: support varies by OpenWA engine and
the deployed engine has not verified outbound interactive messages. Plain URLs work
in normal message text; stored OpenWA templates perform text substitution.

## Import ChatGPT, Claude or CLI history

Download an account export and extract its conversation JSON locally. Keep account
exports and imported histories out of Git. Convert only the selected project chats:

```powershell
node scripts/import-context.mjs --source C:\private\conversations.json --output .\data\context --match agent-bridge
```

Claude's export uses `chat_messages`; ChatGPT uses its selected conversation branch.
The importer also accepts Command Code JSONL messages. Import results are reference
transcripts, not native CLI sessions. Inspect the output before server transfer;
common credential patterns are redacted, but that does not guarantee all sensitive
content has been removed. Export saved memory, custom instructions and project notes
separately where available and include the relevant text in the private context index.
Uploaded files/artifacts may need separate export and inspection.

Put an `INDEX.md` in the private workspace's `context` directory with current decisions
and links to relevant transcripts. The channel includes that index on every turn
(up to 16 KiB); the agent can read the detailed local references when needed.
This shares recorded knowledge across harnesses without inventing native thread IDs.
