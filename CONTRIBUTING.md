# Contributing

Use Node.js 22.6+ and run `npm ci`. Before sending a PR:

```sh
npm run typecheck
npm test
npm run build
```

Tests use fake CLIs and gateways, so credentials and paid model calls are not
required. For a new adapter, implement `AgentRunner`, register its config schema
in `src/harnesses/catalog.ts`, and verify text, tool events, failures, resume,
cancellation and exactly one terminal `done` event. Declare capabilities honestly.

Keep channels independent of model providers. Reuse the event contract and native
CLI permissions instead of inventing another agent loop. Do not commit auth files,
gateway keys, webhook secrets or personal WhatsApp identifiers.
