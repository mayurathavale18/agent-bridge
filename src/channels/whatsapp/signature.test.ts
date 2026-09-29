import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature } from './signature.ts';

const secret = 'test-webhook-secret';

test('computeSignature matches the sha256=HMAC(secret, body) shape OpenWA sends', () => {
  assert.match(computeSignature(secret, '{"a":1}'), /^sha256=[a-f0-9]{64}$/);
});

test('verifies a signature over the exact raw body', () => {
  const body = '{"event":"message.received","data":{"id":"1"}}';
  assert.equal(verifySignature(secret, body, computeSignature(secret, body)), true);
});

test('rejects a tampered body', () => {
  const signature = computeSignature(secret, '{"amount":1}');
  assert.equal(verifySignature(secret, '{"amount":10}', signature), false);
});

test('rejects the wrong secret and a missing header', () => {
  const body = '{"a":1}';
  assert.equal(verifySignature('other-secret', body, computeSignature(secret, body)), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature(secret, body, ''), false);
});

test('verifies a Buffer body (raw bytes, as read off the socket)', () => {
  const raw = Buffer.from('{"event":"message.received"}', 'utf8');
  assert.equal(verifySignature(secret, raw, computeSignature(secret, raw)), true);
});
