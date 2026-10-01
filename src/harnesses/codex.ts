import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, RunRequest } from '../core/runner.ts';
import { tryParseJson } from '../core/ndjson.ts';
import { runProcess } from './cli-process.ts';
import { codexModels } from './models.ts';

export interface CodexConfig {
  binary?: string;
  model?: string;
  effort?: string;
  ignoreUserConfig?: boolean | string;
  sandbox?: 'read-only' | 'workspace-write';
}

export function codexArgs(config: CodexConfig, req: RunRequest): string[] {
  const sandbox = config.sandbox ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Unsupported Codex sandbox');
  // Config overrides work for both exec and exec resume; resume has no --sandbox flag.
  const args = ['exec', ...(req.sessionId ? ['resume'] : []), '--json', '--skip-git-repo-check',
    '-c', 'approval_policy="never"', '-c', `sandbox_mode=${JSON.stringify(sandbox)}`];
  if (config.ignoreUserConfig === true || config.ignoreUserConfig === 'true') args.push('--ignore-user-config');
  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`);
  for (const attachment of req.attachments ?? []) {
    if (attachment.mime.startsWith('image/')) args.push('--image', attachment.path);
  }
  if (req.sessionId) args.push(req.sessionId);
  args.push('--', req.prompt);
  return args;
}

function codexError(raw: string): string {
  const parsed = tryParseJson(raw) as { error?: { message?: string }; message?: string } | null;
  const message = parsed?.error?.message ?? parsed?.message ?? raw;
  return message.includes('not supported')
    ? `${message} Clear Model in the Codex dashboard and click Save & restart to use the CLI default.`
    : message;
}

export class CodexHarness implements AgentRunner {
  readonly id = 'codex';
  private config: CodexConfig;
  constructor(config: CodexConfig = {}) { this.config = config; }
  listModels = codexModels;
  capabilities() { return { streaming: true, resume: true, approvals: false, nativeMcp: true, reportsCost: false }; }
  async *run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    let sessionId = req.sessionId, text = '', reportedError = false;
    yield* runProcess(this.config.binary ?? 'codex', codexArgs(this.config, req), req, (frame): AgentEvent[] => {
      if (frame.type === 'thread.started') sessionId = frame.thread_id;
      if (frame.type === 'error') {
        reportedError = true;
        return [{ type: 'error', message: codexError(frame.message ?? frame.error?.message ?? 'Codex error') }];
      }
      if (frame.type === 'turn.failed') return [
        ...(reportedError ? [] : [{ type: 'error' as const, message: codexError(frame.error?.message ?? 'Codex turn failed') }]),
        { type: 'done', exitCode: 1, text, sessionId }];
      if (frame.type === 'turn.completed') return [
        { type: 'usage', inputTokens: frame.usage?.input_tokens, outputTokens: frame.usage?.output_tokens },
        { type: 'done', exitCode: 0, text, sessionId }];
      const item = frame.item;
      if (!item) return [];
      if (frame.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
        text = item.text; return [{ type: 'text', text: item.text }];
      }
      if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) {
        if (frame.type === 'item.started') return [{ type: 'tool_start', name: item.type,
          detail: item.command ?? item.tool, toolCallId: item.id }];
        if (frame.type === 'item.completed') return [{ type: 'tool_end', name: item.type,
          ok: item.status !== 'failed' && (item.exit_code === undefined || item.exit_code === 0), toolCallId: item.id }];
      }
      return [];
    }, signal);
  }
}

export const createRunner = (config: CodexConfig = {}) => new CodexHarness(config);
