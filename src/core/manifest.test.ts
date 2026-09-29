import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from './manifest.ts';

const base = {
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  kind: 'http' as const,
  url: 'http://localhost:8787',
  capabilities: { streaming: true, resume: false, approvals: false, nativeMcp: false, reportsCost: false },
};

test('accepts a valid http manifest', () => {
  assert.equal(validateManifest(base).id, 'example');
});

test('accepts a valid native manifest', () => {
  const manifest = validateManifest({ ...base, kind: 'native', entry: './runner.js', url: undefined });
  assert.equal(manifest.entry, './runner.js');
});

test('rejects an empty id', () => {
  assert.throws(() => validateManifest({ ...base, id: '' }), /manifest\.id/);
});

test('requires entry for a native manifest', () => {
  assert.throws(() => validateManifest({ ...base, kind: 'native' }), /manifest\.entry/);
});

test('requires url for an http manifest', () => {
  assert.throws(() => validateManifest({ ...base, url: undefined }), /manifest\.url/);
});

test('requires every capability flag to be boolean', () => {
  assert.throws(
    () => validateManifest({ ...base, capabilities: { ...base.capabilities, streaming: 'yes' } }),
    /manifest\.capabilities\.streaming/,
  );
});

test('rejects an unknown kind', () => {
  assert.throws(() => validateManifest({ ...base, kind: 'wasm' }), /manifest\.kind/);
});
