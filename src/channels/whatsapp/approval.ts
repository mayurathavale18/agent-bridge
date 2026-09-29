export type ApprovalDecision = 'approve' | 'deny' | 'cancel';

const APPROVE = new Set(['y', 'yes', 'yeah', 'yep', 'ok', 'okay', 'approve', 'approved', 'allow', 'go', '1']);
const DENY = new Set(['n', 'no', 'nope', 'deny', 'denied', 'reject', '0', '2']);
const CANCEL = new Set(['cancel', 'abort', 'stop', 'kill', 'halt']);

export const APPROVAL_HINT = 'reply "yes" to approve, "no" to deny, or "cancel" to stop the run';

/**
 * Interpret a chat reply as an approval decision.
 *
 * Only the first word is read, so "yes please" and "no thanks" work. Anything unrecognized
 * returns null and the channel re-prompts rather than guessing — guessing on an approval is
 * exactly how an unintended instruction gets executed.
 */
export function parseApprovalAnswer(text: string): ApprovalDecision | null {
  const first = text
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}\p{N}]+$/u, '');
  if (!first) return null;
  if (CANCEL.has(first)) return 'cancel';
  if (APPROVE.has(first)) return 'approve';
  if (DENY.has(first)) return 'deny';
  return null;
}

/** A run parked on a human decision. `settle` unblocks the awaiting run loop. */
export interface PendingApproval {
  id: string;
  prompt: string;
  settle: (decision: ApprovalDecision) => void;
}
