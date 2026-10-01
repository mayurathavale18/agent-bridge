import { readFile, writeFile, rename } from 'node:fs/promises';

export interface SessionRecord {
  /** The harness's own session id, the handle used to resume. */
  sessionId: string;
  updatedAt: number;
}

export interface SessionStoreOptions {
  /** Optional JSON file that persists chat -> session across restarts. */
  file?: string;
  log?: (message: string) => void;
}

/**
 * Maps a chat to the harness session that continues it.
 *
 * This is what turns a stateless webhook channel into a conversation: the harness reports a
 * session id at the end of a run, we keep it per chat, and the next message resumes it. Without
 * a store here, every message would start from an empty context.
 *
 * When opened with a `file`, the mapping survives a restart — which matters for an agent driven
 * from a phone, where the process is not long-lived by nature.
 */
export class SessionStore {
  #byChat = new Map<string, SessionRecord>();
  #threads = new Map<string, { active: string; names: string[] }>();
  #file: string | undefined;
  #log: (message: string) => void;
  #loaded = false;
  #saving: Promise<void> = Promise.resolve();

  constructor(opts: SessionStoreOptions = {}) {
    this.#file = opts.file;
    this.#log = opts.log ?? (() => undefined);
  }

  /** Read the persistence file, if any. Safe to call more than once. */
  async load(): Promise<void> {
    if (!this.#file || this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as Record<string, SessionRecord>;
      const threads = (raw as unknown as { __threads__?: Record<string, { active: string; names: string[] }> }).__threads__;
      for (const [key, entry] of Object.entries(threads ?? {})) {
        if (!entry || !Array.isArray(entry.names)) continue;
        const names = [...new Set(entry.names.filter(name => typeof name === 'string' && validThreadName(name) && name !== 'default'))];
        this.#threads.set(key, { names, active: names.includes(entry.active) ? entry.active : 'default' });
      }
      for (const [chatId, record] of Object.entries(raw)) {
        if (chatId === '__threads__') continue;
        if (record && typeof record.sessionId === 'string' && record.sessionId) {
          this.#byChat.set(chatId, { sessionId: record.sessionId, updatedAt: record.updatedAt ?? 0 });
        }
      }
    } catch {
      // Missing or unreadable file: start empty rather than refusing to boot.
    }
  }

  get(chatId: string): SessionRecord | undefined {
    return this.#byChat.get(chatId);
  }

  threadName(key: string): string {
    return this.#threads.get(key)?.active ?? 'default';
  }

  threadKey(key: string, name = this.threadName(key)): string {
    return name === 'default' ? key : `${key}::${name}`;
  }

  threads(key: string): string[] {
    return ['default', ...(this.#threads.get(key)?.names ?? [])];
  }

  async createThread(key: string, name: string): Promise<void> {
    if (!validThreadName(name)) throw new Error('Thread names must be 1–64 letters, digits, underscores or hyphens.');
    if (this.threads(key).includes(name)) throw new Error('Thread already exists; use /use to select it.');
    const entry = this.#threads.get(key) ?? { active: 'default', names: [] };
    entry.names.push(name);
    entry.active = name;
    this.#threads.set(key, entry);
    await this.save();
  }

  async useThread(key: string, name: string): Promise<void> {
    if (!this.threads(key).includes(name)) throw new Error('Unknown thread; use /threads to list them.');
    const entry = this.#threads.get(key) ?? { active: 'default', names: [] };
    entry.active = name;
    this.#threads.set(key, entry);
    await this.save();
  }

  /** Record the session a run reported. Persists only when it actually changed. */
  remember(chatId: string, sessionId: string): void {
    if (!sessionId) return;
    const existing = this.#byChat.get(chatId);
    if (existing && existing.sessionId === sessionId) {
      existing.updatedAt = Date.now();
      return;
    }
    this.#byChat.set(chatId, { sessionId, updatedAt: Date.now() });
    void this.save();
  }

  /** Forget a chat's session, so the next message starts fresh. */
  clear(chatId: string): void {
    if (!this.#byChat.delete(chatId)) return;
    void this.save();
  }

  get size(): number {
    return this.#byChat.size;
  }

  save(): Promise<void> {
    const file = this.#file;
    if (!file) return Promise.resolve();
    const body = `${JSON.stringify({ ...Object.fromEntries(this.#byChat), __threads__: Object.fromEntries(this.#threads) }, null, 2)}\n`;
    this.#saving = this.#saving.then(async () => {
      try {
        await writeFile(`${file}.tmp`, body, 'utf8');
        await rename(`${file}.tmp`, file);
      } catch (err) {
        this.#log(`could not persist sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.#saving;
  }
}

function validThreadName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}
