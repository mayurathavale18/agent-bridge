import type { MessagingClient } from './types.ts';

export interface OpenWaClientOptions {
  /** OpenWA origin, e.g. `http://127.0.0.1:2785` (the `/api` prefix is added here). */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Thin client for OpenWA messages, reactions and presence.
 */
export class OpenWaClient implements MessagingClient {
  #base: string;
  #key: string;
  #timeoutMs: number;

  constructor(opts: OpenWaClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#key = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? 15000;
  }

  async sendText(
    sessionId: string,
    chatId: string,
    text: string,
    mentions?: string[],
  ): Promise<{ messageId: string; timestamp?: number }> {
    const body: Record<string, unknown> = { chatId, text };
    if (mentions && mentions.length > 0) body.mentions = mentions;
    return this.#post<{ messageId: string; timestamp?: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`,
      body,
    );
  }

  async editText(sessionId: string, chatId: string, messageId: string, body: string): Promise<{ messageId: string }> {
    return this.#post<{ messageId: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages/edit`, {
      chatId,
      messageId,
      body,
    });
  }

  async react(sessionId: string, chatId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.#post(`/api/sessions/${encodeURIComponent(sessionId)}/messages/react`, { chatId, messageId, emoji });
  }

  async sendChatState(sessionId: string, chatId: string, state: 'typing' | 'paused'): Promise<unknown> {
    return this.#post(`/api/sessions/${encodeURIComponent(sessionId)}/chats/typing`, { chatId, state });
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.#key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenWA ${path} -> HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return (await res.json()) as T;
  }
}
