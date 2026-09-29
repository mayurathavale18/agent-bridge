import type { AgentEvent } from '../../core/events.ts';

export const WHATSAPP_TEXT_LIMIT = 4096;

/**
 * Split text into WhatsApp-sized messages on paragraph/word boundaries. WhatsApp has no
 * streaming, so a long answer is delivered as several messages.
 */
export function chunkText(text: string, maxChars: number = WHATSAPP_TEXT_LIMIT): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars / 2) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** One-line progress text for an event, or null when the event should not change the message. */
export function formatProgress(event: AgentEvent): string | null {
  switch (event.type) {
    case 'tool_start':
      return `-> ${event.name}${event.detail ? `: ${event.detail}` : ''}`;
    case 'tool_end':
      return event.ok === false ? `x ${event.name} failed` : `ok ${event.name}`;
    case 'error':
      return `error: ${event.message}`;
    case 'artifact':
      return `artifact: ${event.path}`;
    default:
      return null;
  }
}

/** WhatsApp renders a single backtick pair as monospace; escape nothing else. */
export function asCode(text: string): string {
  return text.includes('`') ? text : `\`${text}\``;
}
