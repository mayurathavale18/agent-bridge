#!/usr/bin/env node
/**
 * Command Code PreToolUse approval hook.
 *
 * Command Code spawns this before shell/write/edit tools run and writes the tool call as
 * JSON on stdin. We forward it to the bridge's approval endpoint, which parks the run until
 * the operator answers in the chat, then translate the answer into Command Code's
 * PreToolUse response shape.
 *
 * FAILS CLOSED: if the bridge is unreachable, unconfigured, or answers anything other than
 * "allow", the tool is denied. A broken approval path must never become a silent yes.
 */

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason ?? '',
      },
    }),
  );
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const url = process.env.AGENT_BRIDGE_APPROVAL_URL;
const runId = process.env.AGENT_BRIDGE_RUN_ID;

if (!url || !runId) {
  respond('deny', 'agent-bridge approval is not configured for this run');
} else {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, payload: JSON.parse(input) }),
    });
    const body = await response.json();
    if (body && body.decision === 'allow') {
      respond('allow', body.reason);
    } else {
      respond('deny', (body && body.reason) || 'denied by the operator');
    }
  } catch (err) {
    respond('deny', `agent-bridge approval failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
