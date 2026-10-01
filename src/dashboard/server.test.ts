import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../core/config-store.ts';
import { DashboardServer } from './server.ts';

interface Harness {
  config: ConfigStore;
  base: string;
  close: () => Promise<void>;
}

async function startDashboard(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = new ConfigStore();
  const server = new DashboardServer({
    config,
    workspace: '/tmp/workspace',
    env,
    log: () => {},
  }).start(0, '127.0.0.1');

  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    config,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const getJson = async (base: string, path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

const sendJson = async (
  base: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('serves the page', async () => {
  const dash = await startDashboard();
  try {
    const res = await fetch(`${dash.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(html.includes('agent-bridge'));
    assert.ok(html.includes('/api/state'), 'the page fetches its state');
  } finally {
    await dash.close();
  }
});

test('rejects cross-origin and form configuration writes', async () => {
  const dash = await startDashboard();
  try {
    for (const headers of [
      { 'content-type': 'application/json', origin: 'https://other.example' },
      { 'content-type': 'text/plain' },
    ]) {
      const res = await fetch(`${dash.base}/api/active`, {
        method: 'POST', headers, body: JSON.stringify({ id: 'mock' }),
      });
      assert.equal(res.status, 403);
      assert.equal(dash.config.activeHarness, undefined);
    }
  } finally { await dash.close(); }
});

test('state lists every catalog harness with schema-derived fields', async () => {
  const dash = await startDashboard();
  try {
    const { status, body } = await getJson(dash.base, '/api/state');
    assert.equal(status, 200);
    assert.equal(body.activeHarness, 'cmd');
    assert.equal(body.workspace, '/tmp/workspace');

    const ids = body.harnesses.map((h: any) => h.manifest.id);
    assert.deepEqual(ids, ['cmd', 'codex', 'claude-code', 'http', 'mock']);

    const cmd = body.harnesses.find((h: any) => h.manifest.id === 'cmd');
    const keys = cmd.fields.map((f: any) => f.key);
    assert.ok(keys.includes('model'));
    assert.ok(keys.includes('approvals'));
    assert.equal(cmd.values.binary, 'cmdc', 'manifest defaults are applied');
    assert.deepEqual(cmd.pinned, []);
  } finally {
    await dash.close();
  }
});

test('saves coerced config values', async () => {
  const dash = await startDashboard();
  try {
    const { status, body } = await sendJson(dash.base, 'PUT', '/api/harnesses/cmd/config', {
      model: 'gpt-6-luna',
      maxTurns: '250',
      approvals: 'true',
    });
    assert.equal(status, 200);
    assert.deepEqual(body.values, { model: 'gpt-6-luna', maxTurns: 250, approvals: true });
    assert.deepEqual(dash.config.harnessConfig('cmd'), { model: 'gpt-6-luna', maxTurns: 250, approvals: true });

    const { body: state } = await getJson(dash.base, '/api/state');
    const cmd = state.harnesses.find((h: any) => h.manifest.id === 'cmd');
    assert.equal(cmd.values.model, 'gpt-6-luna');
  } finally {
    await dash.close();
  }
});

test('rejects invalid values with a reason and stores nothing', async () => {
  const dash = await startDashboard();
  try {
    const { status, body } = await sendJson(dash.base, 'PUT', '/api/harnesses/cmd/config', { maxTurns: 'not-a-number' });
    assert.equal(status, 400);
    assert.equal(body.errors.length, 1);
    assert.deepEqual(dash.config.harnessConfig('cmd'), {});
  } finally {
    await dash.close();
  }
});

test('rejects a config write for an unknown harness', async () => {
  const dash = await startDashboard();
  try {
    const { status } = await sendJson(dash.base, 'PUT', '/api/harnesses/nope/config', { x: 1 });
    assert.equal(status, 404);
  } finally {
    await dash.close();
  }
});

test('switches the active harness', async () => {
  const dash = await startDashboard();
  try {
    const { status } = await sendJson(dash.base, 'POST', '/api/active', { id: 'mock' });
    assert.equal(status, 200);
    assert.equal(dash.config.activeHarness, 'mock');

    const { body } = await getJson(dash.base, '/api/state');
    assert.equal(body.activeHarness, 'mock');
  } finally {
    await dash.close();
  }
});

test('refuses to activate an unknown harness', async () => {
  const dash = await startDashboard();
  try {
    const { status } = await sendJson(dash.base, 'POST', '/api/active', { id: 'ghost' });
    assert.equal(status, 400);
    assert.equal(dash.config.activeHarness, undefined);
  } finally {
    await dash.close();
  }
});

test('an environment variable pins a key, and the state says so', async () => {
  const dash = await startDashboard({ AGENT_BRIDGE_CMD__MODEL: 'from-env' });
  try {
    const { body } = await getJson(dash.base, '/api/state');
    const cmd = body.harnesses.find((h: any) => h.manifest.id === 'cmd');
    assert.equal(cmd.values.model, 'from-env');
    assert.deepEqual(cmd.pinned, ['model']);
  } finally {
    await dash.close();
  }
});

test('404s an unknown route', async () => {
  const dash = await startDashboard();
  try {
    const { status } = await getJson(dash.base, '/api/nope');
    assert.equal(status, 404);
  } finally {
    await dash.close();
  }
});
