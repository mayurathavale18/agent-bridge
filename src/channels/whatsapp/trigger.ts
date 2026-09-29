import type { OpenWaMessage } from './types.ts';

export interface Trigger {
  chatId: string;
  prompt: string;
  /** The triggering message's id — recorded so its echo can never re-trigger a run. */
  messageId: string;
}

export interface TriggerOptions {
  /** The account's own JID. In a self-chat it is derivable, so this is an optional override. */
  selfJid?: string;
  /** Accept a literal `@me` token as well as a real mention. Default true. */
  acceptAtMe?: boolean;
}

const digitsOf = (jid: string): string => (jid.split('@')[0] ?? '').replace(/\D/g, '');

/** Loose JID equality: exact match, or same subscriber digits across id forms (@c.us / @lid). */
function sameJid(a: string, b: string): boolean {
  if (a === b) return true;
  const da = digitsOf(a);
  const db = digitsOf(b);
  return da.length > 0 && da === db;
}

/**
 * A self-chat ("message yourself") message: sent by this account, into this account, not a group.
 * This is the only surface the bridge listens on, which keeps the blast radius to a chat only the
 * operator can post to.
 */
export function isSelfChat(message: OpenWaMessage): boolean {
  return message.fromMe === true && message.isGroup !== true && message.from === message.to;
}

/**
 * Turn a webhook message into a trigger, or null to ignore it.
 *
 * Ignoring is the default and the safety property: a reply the agent itself posted into the
 * self-chat comes back as `fromMe: true` but carries no mention, so it never matches here.
 */
export function extractTrigger(message: OpenWaMessage, opts: TriggerOptions = {}): Trigger | null {
  if (message.isStatusBroadcast === true) return null;
  if (!isSelfChat(message)) return null;

  const selfJid = opts.selfJid ?? message.from;
  const selfDigits = digitsOf(selfJid);
  const mentioned = message.mentionedIds ?? [];

  const mentionedByIid = mentioned.some(jid => sameJid(jid, selfJid));
  const mentionedInBody = selfDigits.length > 0 && new RegExp(`@${selfDigits}(?!\\d)`).test(message.body);
  const hasAtMe = opts.acceptAtMe !== false && /@me\b/i.test(message.body);

  if (!mentionedByIid && !mentionedInBody && !hasAtMe) return null;

  const prompt = stripTriggerTokens(message.body, selfDigits);
  if (!prompt) return null;

  return { chatId: message.chatId, prompt, messageId: message.id };
}

function stripTriggerTokens(body: string, selfDigits: string): string {
  let out = body.replace(/@me\b/gi, ' ');
  if (selfDigits.length > 0) out = out.replace(new RegExp(`@${selfDigits}(?!\\d)`, 'g'), ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Tracks message ids this bridge has sent, so an echo of our own output can never start a run.
 * The mention requirement already prevents loops; this is the belt to that pair of braces.
 */
export class EchoGuard {
  #sent = new Map<string, true>();
  #max: number;

  constructor(max = 500) {
    this.#max = max;
  }

  remember(messageId: string): void {
    if (!messageId) return;
    this.#sent.set(messageId, true);
    if (this.#sent.size > this.#max) {
      const oldest = this.#sent.keys().next().value;
      if (oldest !== undefined) this.#sent.delete(oldest);
    }
  }

  isEcho(messageId: string): boolean {
    return this.#sent.has(messageId);
  }
}
