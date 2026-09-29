import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectText, sessionIdOf, isAgentEvent } from './events.ts';

test('collectText prefers the terminal done text', () => {
  assert.equal(
    collectText([
      { type: 'text', text: 'partial' },
      { type: 'done', exitCode: 0, text: 'final answer' },
    ]),
    'final answer',
  );
});

test('collectText falls back to concatenated text events', () => {
  assert.equal(collectText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
});

test('sessionIdOf reads the session from the done event', () => {
  assert.equal(sessionIdOf([{ type: 'done', exitCode: 0, text: '', sessionId: 's-9' }]), 's-9');
  assert.equal(sessionIdOf([{ type: 'text', text: 'x' }]), undefined);
});

test('isAgentEvent accepts known shapes and rejects others', () => {
  assert.equal(isAgentEvent({ type: 'text', text: 'x' }), true);
  assert.equal(isAgentEvent({ type: 'nope' }), false);
  assert.equal(isAgentEvent('text'), false);
  assert.equal(isAgentEvent(null), false);
});
