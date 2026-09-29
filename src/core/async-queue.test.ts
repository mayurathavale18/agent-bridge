import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQueue } from './async-queue.ts';

test('shift returns a pushed item', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  assert.equal(await queue.shift(), 1);
});

test('a reader that arrives first waits for the next push', async () => {
  const queue = new AsyncQueue<number>();
  const pending = queue.shift();
  queue.push(42);
  assert.equal(await pending, 42);
});

test('close resolves pending and future readers with null', async () => {
  const queue = new AsyncQueue<number>();
  const pending = queue.shift();
  queue.close();
  assert.equal(await pending, null);
  assert.equal(await queue.shift(), null);
});

test('a closed queue drains what it holds, then drops new pushes', async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.close();
  assert.equal(await queue.shift(), 1);
  assert.equal(await queue.shift(), null);
  queue.push(2);
  assert.equal(await queue.shift(), null);
});

test('preserves FIFO order', async () => {
  const queue = new AsyncQueue<string>();
  queue.push('a');
  queue.push('b');
  queue.push('c');
  assert.deepEqual([await queue.shift(), await queue.shift(), await queue.shift()], ['a', 'b', 'c']);
});
