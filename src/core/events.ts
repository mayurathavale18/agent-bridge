/**
 * The normalized event language.
 *
 * This is the centre of the contract: every harness translates its own wire into these
 * events, and every channel renders only these. A channel therefore never knows which
 * harness is behind it, and a harness never knows which chat medium it is talking to.
 */

export type AgentEvent =
  /** Assistant text. May arrive many times during a streaming run. */
  | { type: 'text'; text: string }
  /** A tool call is starting. `detail` is a human-readable one-liner for the chat. */
  | { type: 'tool_start'; name: string; detail?: string; toolCallId?: string }
  /** A tool call finished. `ok` is false when the tool reported an error. */
  | { type: 'tool_end'; name: string; detail?: string; ok?: boolean; toolCallId?: string }
  /**
   * The harness wants a human decision before continuing (a permission prompt).
   * Only harnesses whose capabilities().approvals is true emit this; the channel
   * answers via AgentRunner.respondApproval().
   */
  | { type: 'approval_request'; id: string; prompt: string; options?: string[] }
  /** A file the run produced (diff, screenshot, report) the channel should deliver. */
  | { type: 'artifact'; path: string; mime: string }
  /** Token/cost accounting for the run, emitted as it becomes known. */
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /** A non-fatal error worth surfacing to the user. */
  | { type: 'error'; message: string }
  /**
   * Terminal event. Exactly one per run, always last.
   * `text` is the authoritative final answer; `exitCode` is the harness process exit code.
   */
  | { type: 'done'; exitCode: number; text: string; sessionId?: string; stopReason?: string };

export type AgentEventType = AgentEvent['type'];

export const AGENT_EVENT_TYPES = [
  'text',
  'tool_start',
  'tool_end',
  'approval_request',
  'artifact',
  'usage',
  'error',
  'done',
] as const satisfies readonly AgentEventType[];

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && (AGENT_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * The assistant's final answer from a completed stream. Prefers the terminal `done`
 * event (authoritative) and falls back to concatenated `text` events.
 */
export function collectText(events: readonly AgentEvent[]): string {
  const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done');
  if (done && done.text) return done.text;
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.text)
    .join('');
}

/** The session id a run reported, if any — the handle a channel stores to resume later. */
export function sessionIdOf(events: readonly AgentEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'done' && event.sessionId) return event.sessionId;
  }
  return undefined;
}
