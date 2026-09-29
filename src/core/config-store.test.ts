import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from './config-store.ts';

test('stores the active harness and per-harness values', () => {
  const store = new ConfigStore();
  assert.equal(store.activeHarness, undefined);

  store.setActiveHarness('cmd');
  assert.equal(store.activeHarness, 'cmd');

  store.setHarnessConfig('cmd', { model: 'gpt-6-luna', maxTurns: 50 });
  assert.deepEqual(store.harnessConfig('cmd'), { model: 'gpt-6-luna', maxTurns: 50 });
  assert.deepEqual(store.harnessConfig('never-configured'), {});
});

test('harnessConfig returns a copy, so callers cannot mutate the store by accident', () => {
  const store = new ConfigStore();
  store.setHarnessConfig('cmd', { model: 'x' });
  const copy = store.harnessConfig('cmd');
  copy.model = 'mutated';
  assert.equal(store.harnessConfig('cmd').model, 'x');
});

test('persists to a file and reloads it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  const file = join(dir, 'config.json');
  try {
    const store = new ConfigStore({ file });
    store.setActiveHarness('http');
    store.setHarnessConfig('http', { url: 'http://localhost:8787' });
    await store.save();

    const reopened = new ConfigStore({ file });
    await reopened.load();
    assert.equal(reopened.activeHarness, 'http');
    assert.deepEqual(reopened.harnessConfig('http'), { url: 'http://localhost:8787' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('starts empty when the file is missing or corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  try {
    const missing = new ConfigStore({ file: join(dir, 'absent.json') });
    await missing.load();
    assert.equal(missing.activeHarness, undefined);

    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, 'not json', 'utf8');
    const store = new ConfigStore({ file: corrupt });
    await store.load();
    assert.deepEqual(store.toJSON(), { activeHarness: undefined, harnesses: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
