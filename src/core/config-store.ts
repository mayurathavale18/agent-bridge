import { readFile, writeFile } from 'node:fs/promises';

export interface StoredConfig {
  activeHarness?: string;
  harnesses: Record<string, Record<string, unknown>>;
}

export interface ConfigStoreOptions {
  /** JSON file to persist to. Without one the config lives only for the process. */
  file?: string;
  log?: (message: string) => void;
}

/**
 * The persisted configuration the dashboard edits: which harness is active, and each harness's
 * saved values. File-backed so a dashboard change survives a restart.
 *
 * Precedence is resolved by the caller (see catalog.resolveHarnessConfig): environment above
 * these saved values above the manifest's own defaults.
 */
export class ConfigStore {
  #file: string | undefined;
  #log: (message: string) => void;
  #data: StoredConfig = { harnesses: {} };
  #loaded = false;

  constructor(opts: ConfigStoreOptions = {}) {
    this.#file = opts.file;
    this.#log = opts.log ?? (() => undefined);
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.#file) return;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<StoredConfig>;
      this.#data = {
        activeHarness: typeof parsed.activeHarness === 'string' ? parsed.activeHarness : undefined,
        harnesses:
          parsed.harnesses && typeof parsed.harnesses === 'object' ? { ...parsed.harnesses } : {},
      };
    } catch {
      // Missing or corrupt: start from defaults rather than refusing to boot.
    }
  }

  get activeHarness(): string | undefined {
    return this.#data.activeHarness;
  }

  setActiveHarness(id: string): void {
    if (this.#data.activeHarness === id) return;
    this.#data.activeHarness = id;
    void this.save();
  }

  harnessConfig(id: string): Record<string, unknown> {
    return { ...(this.#data.harnesses[id] ?? {}) };
  }

  setHarnessConfig(id: string, values: Record<string, unknown>): void {
    this.#data.harnesses[id] = { ...values };
    void this.save();
  }

  /** The full stored shape, for rendering and for tests. */
  toJSON(): StoredConfig {
    return { activeHarness: this.#data.activeHarness, harnesses: { ...this.#data.harnesses } };
  }

  async save(): Promise<void> {
    if (!this.#file) return;
    try {
      await writeFile(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.#log(`could not persist config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
