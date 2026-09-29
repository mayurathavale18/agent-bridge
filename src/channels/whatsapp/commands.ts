export type ChatCommand = 'new' | 'session';

/**
 * Recognize a chat control word.
 *
 * Only an exact match counts (optionally `/`- or `!`-prefixed), so a real prompt that merely
 * contains one of these words is still a prompt. Since every self-chat message is a command to
 * the agent, the control words have to be unambiguous rather than intuitive.
 */
export function parseChatCommand(prompt: string): ChatCommand | null {
  const token = prompt
    .trim()
    .toLowerCase()
    .replace(/^[/!]/, '')
    .replace(/[.!?]+$/, '')
    .trim();

  if (token === 'new' || token === 'reset' || token === 'end session') return 'new';
  if (token === 'session' || token === 'status') return 'session';
  return null;
}

export const COMMAND_HELP =
  'commands: `new` forgets this chat\u2019s session, `session` shows the current session id';
