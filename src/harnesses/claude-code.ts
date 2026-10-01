import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, RunRequest } from '../core/runner.ts';
import { runProcess } from './cli-process.ts';
import { cliOutput, claudeModels } from './models.ts';

export interface ClaudeCodeConfig {
  binary?: string;
  model?: string;
  maxTurns?: number;
  permissionMode?: 'plan' | 'dontAsk' | 'acceptEdits' | 'manual';
}

export function claudeArgs(config: ClaudeCodeConfig, req: RunRequest): string[] {
  const mode = config.permissionMode ?? 'plan';
  if (!['plan', 'dontAsk', 'acceptEdits', 'manual'].includes(mode)) throw new Error('Unsupported Claude Code permission mode');
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', mode, '--permission-prompts', mode === 'manual' ? 'host' : 'none'];
  if (mode === 'manual') args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio');
  if (config.model) args.push('--model', config.model);
  if (config.maxTurns !== undefined) args.push('--max-turns', String(config.maxTurns));
  if (req.sessionId) args.push('--resume', req.sessionId);
  if (mode !== 'manual') args.push('--', req.prompt);
  return args;
}

export class ClaudeCodeHarness implements AgentRunner {
  readonly id = 'claude-code';
  private config: ClaudeCodeConfig;
  #model: string | undefined;
  #permissions = new Map<string, { input: unknown; send: (frame: unknown) => void }>();
  constructor(config: ClaudeCodeConfig = {}) { this.config = config; }
  async listModels() { return claudeModels(await cliOutput(this.config.binary ?? 'claude', ['--help'])); }
  resolvedModel() { return this.#model; }
  capabilities() { return { streaming: true, resume: true, approvals: this.config.permissionMode === 'manual', nativeMcp: true, reportsCost: true }; }
  async respondApproval(id: string, decision: 'approve' | 'deny', note?: string) {
    const pending = this.#permissions.get(id);
    if (!pending) return;
    this.#permissions.delete(id);
    pending.send({ type: 'control_response', response: { subtype: 'success', request_id: id,
      response: decision === 'approve' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: note ?? 'Denied by operator' } } });
  }
  async *run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const tools = new Map<string, string>();
    const input = this.config.permissionMode === 'manual' ? [
      { type: 'control_request', request_id: 'bridge-initialize', request: { subtype: 'initialize', hooks: null } },
      { type: 'user', message: { role: 'user', content: req.prompt } },
    ] : undefined;
    try {
    yield* runProcess(this.config.binary ?? 'claude', claudeArgs(this.config, req), req, (frame, send): AgentEvent[] => {
      if (typeof frame.model === 'string') this.#model = frame.model;
      if (typeof frame.message?.model === 'string') this.#model = frame.message.model;
      if (frame.type === 'control_request') {
        if (this.config.permissionMode === 'manual' && frame.request?.subtype === 'can_use_tool' && typeof frame.request_id === 'string') {
          this.#permissions.set(frame.request_id, { input: frame.request.input, send });
          return [{ type: 'approval_request', id: frame.request_id, prompt: `${frame.request.tool_name}: ${JSON.stringify(frame.request.input).slice(0, 2000)}` }];
        }
        send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported bridge control request' } });
        return [];
      }
      if (frame.parent_tool_use_id) return []; // Child-agent output isn't the main answer.
      const delta = frame.type === 'stream_event' ? frame.event?.delta : undefined;
      if (delta?.type === 'text_delta') return [{ type: 'text', text: delta.text }];
      if (frame.type === 'result') {
        const events: AgentEvent[] = [];
        if (frame.is_error) events.push({ type: 'error', message: frame.errors?.join('\n') || frame.result || frame.subtype });
        for (const denial of frame.permission_denials ?? []) events.push({ type: 'error', message: `Permission denied: ${denial.tool_name}` });
        events.push({ type: 'usage', inputTokens: frame.usage?.input_tokens,
          outputTokens: frame.usage?.output_tokens, costUsd: frame.total_cost_usd });
        events.push({ type: 'done', exitCode: frame.is_error ? 1 : 0, text: frame.result ?? '', sessionId: frame.session_id });
        return events;
      }
      const events: AgentEvent[] = [];
      for (const block of frame.message?.content ?? []) {
        if (block.type === 'tool_use') {
          tools.set(block.id, block.name);
          events.push({ type: 'tool_start', name: block.name, toolCallId: block.id,
            detail: block.input?.command ?? block.input?.file_path });
        }
        if (block.type === 'tool_result') events.push({ type: 'tool_end',
          name: tools.get(block.tool_use_id) ?? 'tool', toolCallId: block.tool_use_id, ok: !block.is_error });
      }
      return events;
    }, signal, input);
    } finally { this.#permissions.clear(); }
  }
}

export const createRunner = (config: ClaudeCodeConfig = {}) => new ClaudeCodeHarness(config);
