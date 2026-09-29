import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store.ts';

test('remembers and returns a chat session', () => {
  const store = new SessionStore();
  assert.equal(store.get('chat'), undefined);
  store.remember('chat', 's-1');
  assert.equal(store.get('chat')?.sessionId, 's-1');
});

test('clear forgets a chat', () => {
  const store = new SessionStore();
  store.remember('chat', 's-1');
  store.clear('chat');
  assert.equal(store.get('chat'), undefined);
});

test('ignores an empty session id', () => {
  const store = new SessionStore();
  store.remember('chat', '');
  assert.equal(store.get('chat'), undefined);
});

test('keeps chats independent', () => {
  const store = new SessionStore();
  store.remember('a', 's-a');
  store.remember('b', 's-b');
  assert.equal(store.get('a')?.sessionId, 's-a');
  assert.equal(store.get('b')?.sessionId, 's-b');
});

test('persists to a file and reloads it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-sessions-'));
  const file = join(dir, 'sessions.json');
  try {
    const store = new SessionStore({ file });
    store.remember('chat-a', 's-a');
    await store.save();

    const reopened = new SessionStore({ file });
    await reopened.load();
    assert.equal(reopened.get('chat-a')?.sessionId, 's-a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('starts empty when the file is missing or corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-sessions-'));
  try {
    const missing = new SessionStore({ file: join(dir, 'absent.json') });
    await missing.load();
    assert.equal(missing.size, 0);

    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, 'not json at all', 'utf8');
    const store = new SessionStore({ file: corrupt });
    await store.load();
    assert.equal(store.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
