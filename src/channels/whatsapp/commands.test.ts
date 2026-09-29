import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatCommand } from './commands.ts';

test('recognizes the session-reset words', () => {
  for (const text of ['new', 'NEW', '/new', '!new', 'reset', '/reset', 'end session']) {
    assert.equal(parseChatCommand(text), 'new', `expected new for ${JSON.stringify(text)}`);
  }
});

test('recognizes the session-report words', () => {
  for (const text of ['session', '/session', 'status', 'Status.']) {
    assert.equal(parseChatCommand(text), 'session', `expected session for ${JSON.stringify(text)}`);
  }
});

test('only an exact match counts, so a real prompt is still a prompt', () => {
  for (const text of ['new file please', 'make a new branch', 'session timeout explained', '', '   ']) {
    assert.equal(parseChatCommand(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});
