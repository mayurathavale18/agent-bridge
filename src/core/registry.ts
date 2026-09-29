import type { AgentRunner, HarnessCapabilities } from './runner.ts';

export interface RegisteredHarness {
  id: string;
  capabilities: HarnessCapabilities;
}

/**
 * The set of available harnesses. Channels look a runner up by id; the dashboard lists
 * them to populate its "choose your harness" selector.
 */
export class HarnessRegistry {
  #runners = new Map<string, AgentRunner>();

  register(runner: AgentRunner): this {
    this.#runners.set(runner.id, runner);
    return this;
  }

  get(id: string): AgentRunner {
    const runner = this.#runners.get(id);
    if (!runner) {
      const known = [...this.#runners.keys()].sort().join(', ') || '(none)';
      throw new Error(`unknown harness "${id}"; registered: ${known}`);
    }
    return runner;
  }

  has(id: string): boolean {
    return this.#runners.has(id);
  }

  list(): RegisteredHarness[] {
    return [...this.#runners.values()]
      .map(runner => ({ id: runner.id, capabilities: runner.capabilities() }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
