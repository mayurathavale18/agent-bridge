import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoGuard, extractTrigger, isSelfChat, selfIdSet } from './trigger.ts';
import type { OpenWaMessage } from './types.ts';

const SELF = '917972833243@c.us';

function message(overrides: Partial<OpenWaMessage> = {}): OpenWaMessage {
  return {
    id: 'msg-1',
    from: SELF,
    to: SELF,
    chatId: SELF,
    body: '',
    type: 'chat',
    timestamp: 1700000000,
    fromMe: true,
    isGroup: false,
    kind: 'individual',
    ...overrides,
  };
}

test('a self-chat is fromMe, not a group, and from === to', () => {
  assert.equal(isSelfChat(message()), true);
  assert.equal(isSelfChat(message({ fromMe: false })), false);
  assert.equal(isSelfChat(message({ isGroup: true })), false);
  assert.equal(isSelfChat(message({ to: 'other@c.us' })), false);
});

test('a phone-originated self-chat (phone JID from, LID to) passes with configured self-ids', () => {
  const msg = message({ from: SELF, to: '157076097654949@lid', chatId: '157076097654949@lid', body: '@me do the thing', mentionedIds: [SELF] });
  const ids = selfIdSet('917972833243@c.us,157076097654949@lid');
  assert.equal(isSelfChat(msg, ids), true);
  assert.equal(extractTrigger(msg, { selfJid: ids })?.prompt, 'do the thing');
});

test('selfIdSet splits a comma-separated env string into ids', () => {
  assert.deepEqual(selfIdSet('917972833243@c.us, 157076097654949@lid'), ['917972833243@c.us', '157076097654949@lid']);
  assert.deepEqual(selfIdSet(['a@c.us', 'b@lid']), ['a@c.us', 'b@lid']);
  assert.deepEqual(selfIdSet(undefined), []);
});

test('a mentioned self-chat message becomes a trigger with the mention stripped', () => {
  const trigger = extractTrigger(message({ body: `@${SELF.split('@')[0]} summarize the repo`, mentionedIds: [SELF] }));
  assert.deepEqual(trigger, { chatId: SELF, prompt: 'summarize the repo', messageId: 'msg-1' });
});

test('@me works even when the payload carries no mentions', () => {
  const trigger = extractTrigger(message({ body: '@me fix the failing test', mentionedIds: [] }));
  assert.equal(trigger?.prompt, 'fix the failing test');
});

test('an agent echo (no mention, no @me) is ignored — the loop guard', () => {
  assert.equal(extractTrigger(message({ body: 'done (exit 0)\nhere is the summary' })), null);
});

test('a mention with no instruction is ignored', () => {
  assert.equal(extractTrigger(message({ body: `@${SELF.split('@')[0]}`, mentionedIds: [SELF] })), null);
});

test('messages that are not self-chat are ignored', () => {
  assert.equal(extractTrigger(message({ fromMe: false, body: '@me do something' })), null);
  assert.equal(extractTrigger(message({ isGroup: true, body: '@me do something' })), null);
  assert.equal(extractTrigger(message({ to: 'friend@c.us', body: '@me do something' })), null);
  assert.equal(extractTrigger(message({ isStatusBroadcast: true, body: '@me do something' })), null);
});

test('a mention by a different JID form still matches on subscriber digits', () => {
  const trigger = extractTrigger(message({ body: 'do it', mentionedIds: ['917972833243@lid'] }));
  assert.equal(trigger?.prompt, 'do it');
});

test('EchoGuard remembers sent ids and evicts past its cap', () => {
  const guard = new EchoGuard(2);
  guard.remember('a');
  guard.remember('b');
  assert.equal(guard.isEcho('a'), true);
  guard.remember('c');
  assert.equal(guard.isEcho('a'), false);
  assert.equal(guard.isEcho('c'), true);
  assert.equal(guard.isEcho('never-sent'), false);
});
