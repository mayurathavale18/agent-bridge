import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { AsyncQueue } from '../core/async-queue.ts';
import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, HarnessCapabilities, RunRequest } from '../core/runner.ts';
import { tryParseJson } from '../core/ndjson.ts';
import { installApprovalHook } from './cmd-hook.ts';
import { cliOutput, commandModels } from './models.ts';

/**
 * Adapter for Command Code's headless mode (`cmdc -p … --output-format json`).
 *
 * Stdout carries newline-delimited JSON: event frames as the run progresses, then exactly one
 * terminal `result` line. Unknown frame types are ignored, so a new frame on the cmd side
 * never breaks the bridge.
 *
 * Permissions: headless blocks file writes and shell commands unless `--yolo`/`--permission-mode`
 * relaxes it. `approvals: true` adds a stronger guarantee instead — a `PreToolUse` hook parks
 * each shell/write/edit call until the channel gets an answer from the operator.
 *
 * Docs: https://commandcode.ai/docs (headless mode, hooks, exit codes, JSON output).
 */
export interface CmdConfig {
  /**
   * Executable name or path. Defaults to `cmdc` — the package also ships a `cmd` alias, but
   * on Windows a bare `cmd` resolves to cmd.exe, so `cmdc` is the portable choice. Any
   * `.js`/`.mjs`/`.cjs` value is run through the current Node, which is how the CLI is driven
   * on Windows (its installed launcher is a `.cmd` shim that cannot be exec'd without a shell).
   */
  binary?: string;
  /** Model id, e.g. `claude-sonnet-5`, `gpt-6-luna`, or a BYOK id like `openrouter/…`. */
  model?: string;
  /** Reasoning effort level, e.g. low | medium | high. */
  effort?: string;
  /** Max conversation turns before a partial answer is returned (print-mode default 100). */
  maxTurns?: number;
  /** Permission mode. `standard` (the default) blocks writes and shell. */
  permissionMode?: 'standard' | 'plan' | 'accept-edits' | 'yolo';
  /** Skip taste onboarding — appropriate for automated runs. Defaults to true. */
  skipOnboarding?: boolean;
  /** Auto-trust the workspace, skipping the initial permission prompt. */
  trust?: boolean;
  /** Escape hatch for flags this adapter does not model yet. */
  extraArgs?: string[];

  /** Require an operator decision before shell/write/edit tools run. Default false. */
  approvals?: boolean;
  /** Tool matcher for the approval hook (Command Code tests it against SHELL/READ/WRITE/EDIT). */
  approvalMatcher?: string;
  /** Hook timeout in seconds; Command Code caps it at 600. Must exceed the channel's own timeout. */
  approvalTimeoutSeconds?: number;
  log?: (message: string) => void;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** One parsed line of `cmdc --output-format json` stdout. */
export type CmdFrame =
  | { kind: 'event'; event: Record<string, unknown> }
  | {
      kind: 'result';
      subtype?: string;
      sessionId?: string;
      stopReason?: string;
      finalText: string;
      error?: string;
      usage?: Usage;
    };

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Parse one stdout line into a CmdFrame, or null for blank/garbage/unknown frames. */
export function parseCmdFrame(line: string): CmdFrame | null {
  const raw = tryParseJson(line);
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;

  if (frame.type === 'event' && typeof frame.event === 'object' && frame.event !== null) {
    return { kind: 'event', event: frame.event as Record<string, unknown> };
  }

  if (frame.type === 'result') {
    return {
      kind: 'result',
      subtype: str(frame.subtype),
      sessionId: str(frame.sessionId),
      stopReason: str(frame.stopReason),
      finalText: str(frame.finalText) ?? '',
      error: str(frame.error),
      usage: readUsage(frame.usage),
    };
  }

  return null;
}

function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return i.file_path;
  if (typeof i.description === 'string') return i.description;
  return undefined;
}

/**
 * Translate a `cmd` event frame into an AgentEvent. Only recognized frame types map; anything
 * else returns null and is dropped, so a new frame type never breaks the bridge.
 */
export function mapCmdEventFrame(event: Record<string, unknown>): AgentEvent | null {
  const type = str(event.type) ?? '';
  const name = str(event.toolName) ?? str(event.name);
  const detail = str(event.description) ?? str(event.detail) ?? toolDetail(event.input);
  const toolCallId = str(event.toolCallId);

  // Streaming assistant text arrives as deltas.
  if (type === 'text_delta' && typeof event.delta === 'string') {
    return { type: 'text', text: event.delta };
  }

  if (type === 'tool_queued' || type === 'tool_running' || type === 'tool_start' || type === 'tool_started') {
    return { type: 'tool_start', name: name ?? 'tool', detail, toolCallId };
  }

  // A PreToolUse hook refused the call (our own approval gate lands here when denied).
  if (type === 'tool_hook_blocked') {
    return { type: 'tool_end', name: name ?? 'tool', detail: str(event.hookOutput), ok: false, toolCallId };
  }

  if (/^tool_(completed|complete|finished|ended|end|error|failed)$/.test(type)) {
    return { type: 'tool_end', name: name ?? 'tool', detail, toolCallId, ok: !/error|failed/.test(type) };
  }

  if ((type === 'text' || type === 'assistant_text' || type === 'message') && typeof event.text === 'string') {
    return { type: 'text', text: event.text };
  }

  if (type === 'error' && typeof event.message === 'string') {
    return { type: 'error', message: event.message };
  }

  return null;
}

function readUsage(value: unknown): Usage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const u = value as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const inputTokens = num(u.input_tokens ?? u.inputTokens);
  const outputTokens = num(u.output_tokens ?? u.outputTokens);
  const costUsd = num(u.cost_usd ?? u.costUsd ?? u.total_cost_usd);
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined;
  return { inputTokens, outputTokens, costUsd };
}

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

/** One-line description of the tool call a hook is asking about. */
function describeToolCall(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'a tool call';
  const p = payload as Record<string, unknown>;
  const label = str(p.tool_display_name) ?? str(p.tool_name) ?? 'tool';
  const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>) : {};
  const detail = str(input.command) ?? str(input.file_path) ?? str(input.absolute_path);
  return detail ? `${label}: ${detail}` : label;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class CmdHarness implements AgentRunner {
  readonly id = 'cmd';
  #config: CmdConfig;
  #log: (message: string) => void;

  /** Per-run event queue: stdout frames and approval callbacks both feed it. */
  #runQueues = new Map<string, AsyncQueue<AgentEvent>>();
  /** approval id -> the waiting hook HTTP response. */
  #resolvers = new Map<string, { runId: string; resolve: (decision: 'allow' | 'deny', reason?: string) => void }>();
  #approvalSeq = 0;
  #server: Server | undefined;
  #approvalUrl: string | undefined;

  constructor(config: CmdConfig = {}) {
    this.#config = config;
    this.#log = config.log ?? (() => undefined);
  }

  async listModels() { return commandModels(await cliOutput(this.#config.binary ?? 'cmdc', ['--list-models'])); }

  capabilities(): HarnessCapabilities {
    return {
      streaming: true,
      resume: true,
      approvals: this.#config.approvals === true,
      nativeMcp: true,
      reportsCost: true,
    };
  }

  /** Answer a parked tool call. Called by the channel when the operator replies. */
  async respondApproval(id: string, decision: 'approve' | 'deny', note?: string): Promise<void> {
    const entry = this.#resolvers.get(id);
    if (!entry) return;
    this.#resolvers.delete(id);
    entry.resolve(
      decision === 'approve' ? 'allow' : 'deny',
      note ?? (decision === 'approve' ? 'approved by the operator' : 'denied by the operator'),
    );
  }

  /** Stop the approval callback server. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#approvalUrl = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  #args(prompt: string, sessionId?: string, permissionMode?: CmdConfig['permissionMode']): string[] {
    const c = this.#config;
    const args = ['-p', prompt, '--output-format', 'json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    if (c.model) args.push('--model', c.model);
    if (c.effort) args.push('--effort', c.effort);
    if (c.maxTurns !== undefined) args.push('--max-turns', String(c.maxTurns));
    // `--yolo` rather than `--permission-mode yolo`: the print-mode permission check for the
    // `shell_command` tool looks for the flag itself, and its own error message asks for it.
    if (permissionMode === 'yolo') args.push('--yolo');
    else if (permissionMode && permissionMode !== 'standard') args.push('--permission-mode', permissionMode);
    if (c.skipOnboarding !== false) args.push('--skip-onboarding');
    if (c.trust) args.push('--trust');
    if (c.extraArgs) args.push(...c.extraArgs);
    return args;
  }

  /**
   * Resolve what to execute. A plain executable name is spawned directly (no shell, so the
   * untrusted prompt can never be interpreted as a command). A `.js`/`.mjs`/`.cjs` value is
   * run through the current Node.
   */
  #spawnTarget(
    prompt: string,
    sessionId?: string,
    permissionMode?: CmdConfig['permissionMode'],
  ): { file: string; args: string[] } {
    const binary = this.#config.binary ?? 'cmdc';
    const args = this.#args(prompt, sessionId, permissionMode);
    if (/\.(mjs|cjs|js)$/i.test(binary)) return { file: process.execPath, args: [binary, ...args] };
    return { file: binary, args };
  }

  async *run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = randomUUID();
    const approvalsEnabled = this.#config.approvals === true;

    const env: NodeJS.ProcessEnv = { ...process.env, ...(req.env ?? {}) };
    let restoreHook: (() => Promise<void>) | undefined;
    let permissionMode = this.#config.permissionMode;

    if (approvalsEnabled) {
      // Command Code reads hooks only from settings.json, which has no CLI override — so the gate
      // is installed for the run and the exact previous bytes are restored afterwards. Install it
      // BEFORE relaxing permissions: if the hook cannot be written we keep the blanket denial
      // rather than running unrestricted.
      restoreHook = await installApprovalHook(req.workspace, {
        matcher: this.#config.approvalMatcher,
        timeoutSeconds: this.#config.approvalTimeoutSeconds,
      });
      env.AGENT_BRIDGE_APPROVAL_URL = await this.#ensureServer();
      env.AGENT_BRIDGE_RUN_ID = runId;
      // Headless denies shell/write/edit outright, and that denial is independent of hooks — so
      // without this, every "approve" would still be blocked and the gate would be a no-op. With
      // the gate installed, the operator's decision replaces the blanket denial.
      permissionMode ??= 'yolo';
    }

    const target = this.#spawnTarget(req.prompt, req.sessionId, permissionMode);
    this.#log(`exec: ${target.file} ${target.args.join(' ')}`);

    const queue = new AsyncQueue<AgentEvent>();
    this.#runQueues.set(runId, queue);

    const child = spawn(target.file, target.args, {
      cwd: req.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Attach synchronously after spawn: a failed exec emits 'error' on the next tick, and an
    // unheard 'error' event is fatal to the process.
    let spawnError: Error | undefined;
    child.once('error', err => {
      spawnError = err;
    });
    const closed = new Promise<number>(resolve => child.once('close', code => resolve(code ?? 0)));

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let streamed = '';
    let finalText = '';
    let sessionId: string | undefined;
    let stopReason: string | undefined;

    // stdout -> queue. Always closes the queue, so the drain loop below can never hang.
    const reader = (async () => {
      try {
        const lines = createInterface({ input: child.stdout });
        for await (const line of lines) {
          const frame = parseCmdFrame(line);
          if (!frame) continue;
          if (frame.kind === 'event') {
            const event = mapCmdEventFrame(frame.event);
            if (event) queue.push(event);
            continue;
          }
          if (frame.sessionId) sessionId = frame.sessionId;
          if (frame.stopReason) stopReason = frame.stopReason;
          if (frame.finalText) finalText = frame.finalText;
          if (frame.usage) queue.push({ type: 'usage', ...frame.usage });
          if (frame.error) queue.push({ type: 'error', message: frame.error });
        }
      } catch (err) {
        spawnError ??= err instanceof Error ? err : new Error(String(err));
      } finally {
        queue.close();
      }
    })();

    try {
      for (;;) {
        const event = await queue.shift();
        if (!event) break;
        if (event.type === 'text') streamed += event.text;
        yield event;
      }

      await reader;
      if (spawnError) throw spawnError;
      const exitCode = await closed;

      const text = finalText || streamed;
      if (!streamed && text) yield { type: 'text', text };
      if (exitCode !== 0 && stderr.trim()) yield { type: 'error', message: lastLines(stderr, 5) };
      yield { type: 'done', exitCode, text, sessionId, stopReason };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      yield { type: 'done', exitCode: 1, text: streamed, sessionId, stopReason };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#runQueues.delete(runId);
      // A parked hook must never outlive its run: deny anything still waiting.
      for (const [id, entry] of [...this.#resolvers]) {
        if (entry.runId === runId) {
          this.#resolvers.delete(id);
          entry.resolve('deny', 'the run ended before the approval was answered');
        }
      }
      try {
        child.kill();
      } catch {
        // already exited
      }
      if (restoreHook) await restoreHook();
    }
  }

  async #ensureServer(): Promise<string> {
    if (this.#approvalUrl) return this.#approvalUrl;

    const server = createServer((req, res) => {
      void this.#onHookRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    this.#server = server;
    this.#approvalUrl = `http://127.0.0.1:${port}/approval`;
    this.#log(`approval callback server on ${this.#approvalUrl}`);
    return this.#approvalUrl;
  }

  /** A hook is asking whether a tool may run: park it and surface an approval_request. */
  async #onHookRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const raw = await readBody(req);
    let body: { runId?: unknown; payload?: unknown };
    try {
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const runId = typeof body.runId === 'string' ? body.runId : '';
    const queue = this.#runQueues.get(runId);
    if (!queue) {
      // Fail closed: an unknown run must not be silently allowed through.
      reply(res, { decision: 'deny', reason: 'agent-bridge: unknown run' });
      return;
    }

    const approvalId = `ap-${++this.#approvalSeq}`;
    const prompt = describeToolCall(body.payload);
    this.#log(`approval requested: ${prompt}`);

    const answer = await new Promise<{ decision: 'allow' | 'deny'; reason?: string }>(resolve => {
      this.#resolvers.set(approvalId, {
        runId,
        resolve: (decision, reason) => resolve({ decision, reason }),
      });
      queue.push({ type: 'approval_request', id: approvalId, prompt });
    });

    reply(res, answer);
  }
}

function reply(res: ServerResponse, body: { decision: 'allow' | 'deny'; reason?: string }): void {
  if (res.headersSent) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Native plugin entry point: a manifest's `entry` module must export this. */
export function createRunner(config: Record<string, unknown> = {}): AgentRunner {
  return new CmdHarness(config as CmdConfig);
}
