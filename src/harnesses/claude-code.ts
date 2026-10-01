import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, RunRequest } from '../core/runner.ts';
import { runProcess } from './cli-process.ts';
import { cliOutput, claudeModels } from './models.ts';

export interface ClaudeCodeConfig {
  binary?: string;
  model?: string;
  maxTurns?: number;
  permissionMode?: 'plan' | 'dontAsk' | 'acceptEdits';
}

export function claudeArgs(config: ClaudeCodeConfig, req: RunRequest): string[] {
  const mode = config.permissionMode ?? 'plan';
  if (!['plan', 'dontAsk', 'acceptEdits'].includes(mode)) throw new Error('Unsupported Claude Code permission mode');
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', mode, '--permission-prompts', 'none'];
  if (config.model) args.push('--model', config.model);
  if (config.maxTurns !== undefined) args.push('--max-turns', String(config.maxTurns));
  if (req.sessionId) args.push('--resume', req.sessionId);
  args.push('--', req.prompt);
  return args;
}

export class ClaudeCodeHarness implements AgentRunner {
  readonly id = 'claude-code';
  private config: ClaudeCodeConfig;
  constructor(config: ClaudeCodeConfig = {}) { this.config = config; }
  async listModels() { return claudeModels(await cliOutput(this.config.binary ?? 'claude', ['--help'])); }
  capabilities() { return { streaming: true, resume: true, approvals: false, nativeMcp: true, reportsCost: true }; }
  async *run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const tools = new Map<string, string>();
    yield* runProcess(this.config.binary ?? 'claude', claudeArgs(this.config, req), req, (frame): AgentEvent[] => {
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
    }, signal);
  }
}

export const createRunner = (config: ClaudeCodeConfig = {}) => new ClaudeCodeHarness(config);
