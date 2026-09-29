import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledApprovalHookPath, installApprovalHook } from './cmd-hook.ts';

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-bridge-hook-'));
}

test('the bundled hook script exists', () => {
  assert.equal(existsSync(bundledApprovalHookPath()), true);
});

test('installs a PreToolUse hook, and removes the file it created on restore', async () => {
  const dir = await tempWorkspace();
  try {
    const restore = await installApprovalHook(dir);

    const settings = JSON.parse(await readFile(join(dir, '.commandcode', 'settings.json'), 'utf8'));
    const definition = settings.hooks.PreToolUse[0];
    assert.equal(definition.matcher, 'shell|write|edit');
    assert.match(definition.hooks[0].command, /cmd-approval-hook\.mjs/);
    assert.equal(definition.hooks[0].timeout, 600);

    await restore();
    assert.equal(existsSync(join(dir, '.commandcode')), false, 'the directory it created is removed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preserves existing settings and other hooks, restoring the exact bytes', async () => {
  const dir = await tempWorkspace();
  try {
    await mkdir(join(dir, '.commandcode'), { recursive: true });
    const original =
      `${JSON.stringify(
        {
          hooks: { PreToolUse: [{ matcher: 'read', hooks: [{ type: 'command', command: 'echo hi' }] }] },
          theme: 'dark',
        },
        null,
        2,
      )}\n`;
    await writeFile(join(dir, '.commandcode', 'settings.json'), original, 'utf8');

    const restore = await installApprovalHook(dir);

    const merged = JSON.parse(await readFile(join(dir, '.commandcode', 'settings.json'), 'utf8'));
    assert.equal(merged.theme, 'dark', 'unrelated keys survive');
    assert.equal(merged.hooks.PreToolUse.length, 2, 'the existing hook is kept');
    assert.equal(merged.hooks.PreToolUse[0].matcher, 'read', 'and stays first');

    await restore();
    assert.equal(await readFile(join(dir, '.commandcode', 'settings.json'), 'utf8'), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installing twice does not duplicate the hook', async () => {
  const dir = await tempWorkspace();
  try {
    await installApprovalHook(dir);
    await installApprovalHook(dir);
    const settings = JSON.parse(await readFile(join(dir, '.commandcode', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('honours a custom matcher and timeout', async () => {
  const dir = await tempWorkspace();
  try {
    await installApprovalHook(dir, { matcher: 'shell', timeoutSeconds: 120 });
    const settings = JSON.parse(await readFile(join(dir, '.commandcode', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'shell');
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 120);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
