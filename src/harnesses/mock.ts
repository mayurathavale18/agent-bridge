import type { AgentEvent } from '../core/events.ts';
import type { AgentRunner, HarnessCapabilities, RunRequest } from '../core/runner.ts';

/**
 * A deterministic harness that calls no model. Used by the demo and the test suite so the
 * whole pipeline (channel → runner → events) can be exercised without network or cost.
 */
export class MockHarness implements AgentRunner {
  readonly id = 'mock';

  capabilities(): HarnessCapabilities {
    return { streaming: true, resume: true, approvals: false, nativeMcp: false, reportsCost: true };
  }

  async *run(req: RunRequest, _signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const answer = `echo: ${req.prompt}`;
    yield { type: 'text', text: answer };
    yield { type: 'tool_start', name: 'read_file', detail: req.workspace, toolCallId: 't1' };
    yield { type: 'tool_end', name: 'read_file', ok: true, toolCallId: 't1' };
    yield { type: 'usage', inputTokens: 12, outputTokens: 34 };
    yield { type: 'done', exitCode: 0, text: answer, sessionId: 'mock-session', stopReason: 'end_turn' };
  }
}

/** Native plugin entry point: a manifest's `entry` module must export this. */
export function createRunner(): AgentRunner {
  return new MockHarness();
}
