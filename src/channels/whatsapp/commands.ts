export type ChatCommand = 'new' | 'session' | { name: 'help' | 'threads' | 'new' | 'use' | 'models' | 'model' | 'harnesses' | 'harness' | 'send' | 'unknown'; argument: string };

/**
 * Recognize a chat control word.
 *
 * Only an exact match counts (optionally `/`- or `!`-prefixed), so a real prompt that merely
 * contains one of these words is still a prompt. Since every self-chat message is a command to
 * the agent, the control words have to be unambiguous rather than intuitive.
 */
export function parseChatCommand(prompt: string): ChatCommand | null {
  const explicit = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (explicit) {
    const name = explicit[1]!.toLowerCase();
    const argument = explicit[2]?.trim() ?? '';
    if (name === 'help' || name === 'threads' || name === 'use' || name === 'models' || name === 'model' || name === 'harnesses' || name === 'harness' || name === 'send' || (name === 'new' && argument)) {
      return { name, argument };
    }
    if (!['new', 'reset', 'session', 'status'].includes(name) || argument) return { name: 'unknown', argument: prompt.trim() };
  }
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
  'commands: /new starts fresh, /new <name> creates a thread, /threads lists threads, /use <name> resumes one, /session shows the session, /models lists models, /model <id|default> switches model, /harnesses lists adapters, /harness <id> switches adapter, /send <path> sends a workspace file, /help shows commands';
