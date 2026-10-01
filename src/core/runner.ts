import type { AgentEvent } from './events.ts';

/**
 * What a harness can do. The bridge reads this to decide policy (e.g. only harnesses with
 * `approvals` can be run on a chat channel that supports approval round-trips) and the
 * dashboard reads it to render only the controls that apply.
 *
 * Declare honestly: a channel that assumes `streaming` from a harness that does not
 * stream will show nothing until the run ends.
 */
export interface HarnessCapabilities {
  /** Emits `text`/`tool_*` events as the run progresses (vs. only a final `done`). */
  streaming: boolean;
  /** Can continue a previous run given a sessionId. */
  resume: boolean;
  /** Emits `approval_request` and implements respondApproval(). */
  approvals: boolean;
  /** Brings its own tool servers (MCP), so the bridge need not inject any. */
  nativeMcp: boolean;
  /** Reports token/cost via `usage` events. */
  reportsCost: boolean;
  /** Optional advertised model ids for the config UI. */
  models?: string[];
}

/** A single run request. The bridge is model-agnostic: model choice lives in `config`. */
export interface RunRequest {
  /** The user's instruction, already stripped of the channel's trigger token. */
  prompt: string;
  /** Absolute path the harness should treat as its working directory. */
  workspace: string;
  /** Resume this prior session, when the harness supports it. */
  sessionId?: string;
  attachments?: { path: string; mime: string }[];
  /** Harness-specific settings (model, maxTurns, permissionMode, …). */
  config?: Record<string, unknown>;
  /** Extra environment variables for the child process (secrets are injected here, never in config). */
  env?: Record<string, string>;
}

/**
 * The one interface every harness implements. Native harnesses implement it directly;
 * out-of-process harnesses use the HTTP wire (see docs/harness-spec.md) via HttpHarness.
 */
export interface AgentRunner {
  readonly id: string;

  capabilities(): HarnessCapabilities;
  /** Native catalog, when available; absence means model discovery is unsupported. */
  listModels?(): Promise<string[]>;
  resolvedModel?(): string | undefined;

  /**
   * Execute one run, yielding normalized events. Must yield exactly one terminal
   * `done` event as the last item, including on error and on abort.
   */
  run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>;

  /**
   * Deliver the human's answer for a previously emitted `approval_request`.
   * Required only when capabilities().approvals is true.
   */
  respondApproval?(approvalId: string, decision: 'approve' | 'deny', note?: string): Promise<void>;
  respondChoice?(questionId: string, optionId: string | null): Promise<void>;
}
