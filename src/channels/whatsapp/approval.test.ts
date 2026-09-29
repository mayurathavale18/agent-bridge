import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApprovalAnswer } from './approval.ts';

test('recognizes approvals, including as the first word of a sentence', () => {
  for (const text of ['yes', 'y', 'YES', 'Yes please', 'ok', 'okay!', 'approve', 'go ahead', '1']) {
    assert.equal(parseApprovalAnswer(text), 'approve', `expected approve for ${JSON.stringify(text)}`);
  }
});

test('recognizes denials, including as the first word of a sentence', () => {
  for (const text of ['no', 'n', 'No thanks', 'nope', 'deny', 'reject', '0', '2']) {
    assert.equal(parseApprovalAnswer(text), 'deny', `expected deny for ${JSON.stringify(text)}`);
  }
});

test('cancel is its own decision, so the run can be stopped', () => {
  for (const text of ['cancel', 'Cancel it', 'abort', 'stop', 'kill']) {
    assert.equal(parseApprovalAnswer(text), 'cancel');
  }
});

test('anything unrecognized returns null — the channel re-prompts instead of guessing', () => {
  for (const text of ['', '   ', 'what does it do?', 'maybe', 'hold on', 'not now', '??']) {
    assert.equal(parseApprovalAnswer(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});

test('cancel takes precedence over a leading affirmative word', () => {
  assert.equal(parseApprovalAnswer('cancel the run'), 'cancel');
});
