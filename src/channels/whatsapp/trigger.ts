import type { OpenWaMessage } from './types.ts';

export interface Trigger {
  chatId: string;
  prompt: string;
  /** The triggering message's id — recorded so its echo can never re-trigger a run. */
  messageId: string;
}

export interface TriggerOptions {
  /** The account's own JID(s) — comma-separated string or list. Defaults to message.from. */
  selfJid?: string | string[];
  /** Allow the @me token as a trigger. Default true. */
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

/** The account's own identities: WhatsApp addresses the self-chat with BOTH the phone JID and the LID. */
export function selfIdSet(selfIds: string | string[] | undefined): string[] {
  if (!selfIds) return [];
  const list = typeof selfIds === 'string' ? selfIds.split(',') : selfIds;
  return list.map(s => s.trim()).filter(Boolean);
}

function matchesAny(jid: string, ids: readonly string[]): boolean {
  return ids.some(id => sameJid(jid, id));
}

/**
 * A self-chat ("message yourself") message: sent by this account, into this account, not a group.
 *
 * WhatsApp does not use one stable JID for the account: a phone-originated self-chat arrives as
 * `from` = the phone JID (@c.us) and `to` = the account LID (@lid), while an API-originated one
 * can arrive with both as the LID. So the check is "both sides are the account's own identities"
 * against the configured self-ids — not `from === to`, which silently drops phone-typed messages.
 */
export function isSelfChat(message: OpenWaMessage, selfIds: readonly string[] = []): boolean {
  if (message.fromMe !== true || message.isGroup === true) return false;
  const from = message.from;
  const to = message.to;
  const ids = selfIdSet(selfIds);
  if (ids.length === 0) return from === to;
  return matchesAny(from, ids) && matchesAny(to, ids);
}

/**
 * Turn a webhook message into a trigger, or null to ignore it.
 *
 * Ignoring is the default and the safety property: a reply the agent itself posted into the
 * self-chat comes back as `fromMe: true` but carries no mention, so it never matches here.
 */
export function extractTrigger(message: OpenWaMessage, opts: TriggerOptions = {}): Trigger | null {
  if (message.isStatusBroadcast === true) return null;
  const ids = selfIdSet(opts.selfJid);
  if (!isSelfChat(message, ids)) return null;

  const selfJid = ids[0] ?? (typeof opts.selfJid === 'string' ? opts.selfJid : undefined) ?? message.from;
  const selfDigits = digitsOf(selfJid);
  const mentioned = message.mentionedIds ?? [];

  const mentionedById = mentioned.some(jid => sameJid(jid, selfJid));
  const mentionedInBody = selfDigits.length > 0 && new RegExp(`@${selfDigits}(?!\\d)`).test(message.body);
  const hasAtMe = opts.acceptAtMe !== false && /@me\b/i.test(message.body);

  if (!mentionedById && !mentionedInBody && !hasAtMe) return null;

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
