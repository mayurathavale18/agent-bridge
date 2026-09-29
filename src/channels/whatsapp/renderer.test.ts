import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, formatProgress } from './renderer.ts';

test('chunkText returns one chunk under the limit', () => {
  assert.deepEqual(chunkText('hello', 100), ['hello']);
});

test('chunkText splits on newlines and keeps every chunk within the limit', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i} of some text`).join('\n');
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
});

test('chunkText falls back to a hard cut when there is no boundary', () => {
  const chunks = chunkText('x'.repeat(250), 100);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test('formatProgress renders tool activity and ignores non-progress events', () => {
  assert.equal(formatProgress({ type: 'tool_start', name: 'read_file', detail: 'src/index.ts' }), '-> read_file: src/index.ts');
  assert.equal(formatProgress({ type: 'tool_end', name: 'read_file', ok: true }), 'ok read_file');
  assert.equal(formatProgress({ type: 'tool_end', name: 'shell', ok: false }), 'x shell failed');
  assert.equal(formatProgress({ type: 'error', message: 'boom' }), 'error: boom');
  assert.equal(formatProgress({ type: 'text', text: 'hi' }), null);
  assert.equal(formatProgress({ type: 'usage', inputTokens: 1 }), null);
});
