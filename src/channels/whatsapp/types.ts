/**
 * Wire types for OpenWA webhooks and messages.
 *
 * The envelope matches what OpenWA delivers: `{ event, timestamp, sessionId, idempotencyKey,
 * deliveryId, data }`. For `message.received`, `data` is the engine-neutral IncomingMessage
 * (see OpenWA `src/engine/interfaces/whatsapp-engine.interface.ts`).
 */

export interface OpenWaWebhookEnvelope {
  event: string;
  timestamp?: string;
  sessionId: string;
  idempotencyKey?: string;
  deliveryId?: string;
  data: OpenWaMessage;
}

export interface OpenWaMessage {
  id: string;
  /** Author JID. In a self-chat this equals `to` and `chatId`. */
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: string;
  /** Unix seconds. */
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  kind: string;
  /** For group/status/broadcast, the actual sender (when `from` is the group id). */
  author?: string;
  /** JIDs @mentioned in the message. */
  mentionedIds?: string[];
  isStatusBroadcast?: boolean;
}

/** The minimum of OpenWA we depend on. Lets the channel be tested against a fake. */
export interface MessagingClient {
  react?(sessionId: string, chatId: string, messageId: string, emoji: string): Promise<unknown>;
  sendChatState?(sessionId: string, chatId: string, state: 'typing' | 'paused'): Promise<unknown>;
  sendText(
    sessionId: string,
    chatId: string,
    text: string,
    mentions?: string[],
  ): Promise<{ messageId: string; timestamp?: number }>;
  editText(sessionId: string, chatId: string, messageId: string, body: string): Promise<{ messageId: string }>;
}
