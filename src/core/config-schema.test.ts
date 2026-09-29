import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceValues, envKeyFor, envOverrides, fieldDescriptors, schemaDefaults } from './config-schema.ts';
import type { JsonSchema } from './manifest.ts';

const schema: JsonSchema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', title: 'Base URL' },
    model: { type: 'string', title: 'Model', default: 'auto', description: 'which model' },
    maxTurns: { type: 'number', default: 100, title: 'Max turns' },
    mode: { type: 'string', enum: ['a', 'b'], title: 'Mode' },
    approvals: { type: 'boolean', default: false, title: 'Approvals' },
    secret: { type: 'string', title: 'Key', format: 'password' },
    list: { type: 'array', items: { type: 'string' }, title: 'Ignored' },
  },
};

test('derives one descriptor per supported property, skipping unsupported shapes', () => {
  assert.deepEqual(
    fieldDescriptors(schema).map(f => f.key),
    ['url', 'model', 'maxTurns', 'mode', 'approvals', 'secret'],
  );
});

test('classifies types, with enum taking precedence over type', () => {
  const byKey = Object.fromEntries(fieldDescriptors(schema).map(f => [f.key, f]));
  assert.equal(byKey.mode?.type, 'enum');
  assert.deepEqual(byKey.mode?.options, ['a', 'b']);
  assert.equal(byKey.maxTurns?.type, 'number');
  assert.equal(byKey.approvals?.type, 'boolean');
  assert.equal(byKey.url?.required, true);
  assert.equal(byKey.secret?.format, 'password');
  assert.equal(byKey.model?.description, 'which model');
});

test('handles a missing or empty schema', () => {
  assert.deepEqual(fieldDescriptors(undefined), []);
  assert.deepEqual(fieldDescriptors({ type: 'object' }), []);
  assert.deepEqual(schemaDefaults(undefined), {});
});

test('schemaDefaults collects declared defaults only', () => {
  assert.deepEqual(schemaDefaults(schema), { model: 'auto', maxTurns: 100, approvals: false });
});

test('coerces string input into the declared types and drops unknown keys', () => {
  const { values, errors } = coerceValues(schema, {
    url: 'http://localhost:8787',
    maxTurns: '250',
    approvals: 'true',
    mode: 'a',
    notInSchema: 'ignored',
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { url: 'http://localhost:8787', maxTurns: 250, approvals: true, mode: 'a' });
});

test('reports invalid values instead of storing them', () => {
  const { values, errors } = coerceValues(schema, { url: 'x', maxTurns: 'abc', mode: 'z' });
  assert.equal(errors.length, 2);
  assert.deepEqual(values, { url: 'x' });
});

test('reports a missing required field', () => {
  assert.deepEqual(coerceValues(schema, {}).errors, ['Base URL is required']);
});

test('treats blank values as unset rather than empty strings', () => {
  const { values, errors } = coerceValues(schema, { url: 'http://x', model: '' });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { url: 'http://x' });
});

test('envKeyFor builds the documented name', () => {
  assert.equal(envKeyFor('cmd', 'maxTurns'), 'AGENT_BRIDGE_CMD__MAX_TURNS');
  assert.equal(envKeyFor('my-http', 'baseURL'), 'AGENT_BRIDGE_MY_HTTP__BASE_URL');
});

test('envOverrides coerces by schema type and skips blank values', () => {
  const overrides = envOverrides('cmd', schema, {
    AGENT_BRIDGE_CMD__MAX_TURNS: '42',
    AGENT_BRIDGE_CMD__APPROVALS: 'true',
    AGENT_BRIDGE_CMD__MODE: 'b',
    AGENT_BRIDGE_CMD__URL: '   ',
  });
  assert.deepEqual(overrides, { maxTurns: 42, approvals: true, mode: 'b' });
});
