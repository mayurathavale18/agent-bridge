import { createInterface } from 'node:readline/promises';
import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, RunRequest } from '../core/runner.ts';

export interface CliOptions {
  prompt: string;
  workspace: string;
  sessionId?: string;
  config?: Record<string, unknown>;
}

type ApprovalEvent = Extract<AgentEvent, { type: 'approval_request' }>;

/**
 * A minimal channel: renders the normalized event stream to a terminal. Its only job is to
 * prove the contract end to end — the WhatsApp channel will render the same events with
 * message edits instead of stdout writes.
 */
export async function runCli(runner: AgentRunner, opts: CliOptions): Promise<number> {
  const request: RunRequest = {
    prompt: opts.prompt,
    workspace: opts.workspace,
    sessionId: opts.sessionId,
    config: opts.config,
  };

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let exitCode = 1;
  let streamedText = false;

  try {
    for await (const event of runner.run(request)) {
      switch (event.type) {
        case 'text':
          streamedText = true;
          process.stdout.write(event.text.endsWith('\n') ? event.text : `${event.text}\n`);
          break;
        case 'tool_start':
          process.stdout.write(`--> ${event.name}${event.detail ? `: ${event.detail}` : ''}\n`);
          break;
        case 'tool_end':
          process.stdout.write(`    ${event.ok === false ? 'FAILED' : 'ok'} ${event.name}\n`);
          break;
        case 'artifact':
          process.stdout.write(`artifact: ${event.path} (${event.mime})\n`);
          break;
        case 'usage': {
          const parts = [
            event.inputTokens !== undefined ? `in=${event.inputTokens}` : '',
            event.outputTokens !== undefined ? `out=${event.outputTokens}` : '',
            event.costUsd !== undefined ? `cost=$${event.costUsd}` : '',
          ].filter(Boolean);
          if (parts.length > 0) process.stdout.write(`usage: ${parts.join(' ')}\n`);
          break;
        }
        case 'error':
          process.stderr.write(`error: ${event.message}\n`);
          break;
        case 'approval_request': {
          const decision = await askApproval(rl, runner, event);
          process.stdout.write(`approval: ${decision}\n`);
          break;
        }
        case 'done':
          exitCode = event.exitCode;
          if (!streamedText && event.text) {
            process.stdout.write(event.text.endsWith('\n') ? event.text : `${event.text}\n`);
          }
          process.stdout.write(
            `done (exit ${event.exitCode}${event.sessionId ? `, session ${event.sessionId}` : ''})\n`,
          );
          break;
      }
    }
  } finally {
    rl?.close();
  }

  return exitCode;
}

async function askApproval(
  rl: ReturnType<typeof createInterface> | null,
  runner: AgentRunner,
  event: ApprovalEvent,
): Promise<string> {
  if (!runner.respondApproval) {
    process.stderr.write(`approval requested but this harness has no approval transport: ${event.prompt}\n`);
    return 'unanswered';
  }

  const options = event.options ?? ['approve', 'deny'];
  let decision: 'approve' | 'deny' = 'deny';
  if (rl) {
    const answer = (await rl.question(`approval: ${event.prompt} [${options.join('/')}] `)).trim().toLowerCase();
    decision = answer === 'approve' || answer.startsWith('y') ? 'approve' : 'deny';
  } else {
    process.stderr.write(`no TTY to answer approval, denying: ${event.prompt}\n`);
  }

  await runner.respondApproval(event.id, decision);
  return decision;
}
