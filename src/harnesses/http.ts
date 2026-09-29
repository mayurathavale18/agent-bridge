import { isAgentEvent, type AgentEvent } from '../core/events.ts';
import { ndjsonLines, tryParseJson } from '../core/ndjson.ts';
import type { AgentRunner, HarnessCapabilities, RunRequest } from '../core/runner.ts';

export interface HttpHarnessOptions {
  /** Harness id shown in the registry. */
  id?: string;
  /** Base URL of the harness service; the bridge POSTs to `${url}/runs`. */
  url: string;
  /** Settings merged into every run request body. */
  config?: Record<string, unknown>;
  /** Overrides for the advertised capabilities. */
  capabilities?: Partial<HarnessCapabilities>;
}

/**
 * Adapter for the language-agnostic HTTP harness wire (docs/harness-spec.md).
 *
 * A harness in any language implements one endpoint:
 *   POST {url}/runs  →  200, application/x-ndjson, one AgentEvent per line
 * The bridge streams those lines straight through, so an out-of-process harness is a
 * first-class plugin with no shared runtime.
 */
export class HttpHarness implements AgentRunner {
  readonly id: string;
  #url: string;
  #config: Record<string, unknown>;
  #capabilities: HarnessCapabilities;

  constructor(opts: HttpHarnessOptions) {
    this.id = opts.id ?? 'http';
    this.#url = opts.url.replace(/\/+$/, '');
    this.#config = opts.config ?? {};
    this.#capabilities = {
      streaming: true,
      resume: true,
      approvals: false,
      nativeMcp: false,
      reportsCost: false,
      ...opts.capabilities,
    };
  }

  capabilities(): HarnessCapabilities {
    return this.#capabilities;
  }

  async *run(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.#url}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({
          prompt: req.prompt,
          workspace: req.workspace,
          sessionId: req.sessionId,
          config: { ...this.#config, ...(req.config ?? {}) },
        }),
        signal,
      });
    } catch (err) {
      yield { type: 'error', message: `harness request failed: ${err instanceof Error ? err.message : String(err)}` };
      yield { type: 'done', exitCode: 1, text: '' };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: 'error', message: `harness returned HTTP ${response.status}` };
      yield { type: 'done', exitCode: 1, text: '' };
      return;
    }

    let text = '';
    for await (const line of ndjsonLines(response.body)) {
      const parsed = tryParseJson(line);
      if (!isAgentEvent(parsed)) continue;
      if (parsed.type === 'text') text += parsed.text;
      if (parsed.type === 'done') {
        yield { ...parsed, text: parsed.text || text };
        return;
      }
      yield parsed;
    }

    yield { type: 'done', exitCode: 0, text };
  }
}
