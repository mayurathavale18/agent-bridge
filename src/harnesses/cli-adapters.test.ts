import type { AgentEvent } from '../core/events.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHarness, codexArgs } from './codex.ts';
import { ClaudeCodeHarness, claudeArgs } from './claude-code.ts';
import { permissionSettings } from './catalog.ts';

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('CLI flags preserve prompts and enforce noninteractive permissions on resume', () => {
  const req = { workspace: '.', prompt: '--bad; echo unsafe', sessionId: 'session' };
  const codex = codexArgs({}, req);
  assert.deepEqual(codex.slice(0, 2), ['exec', 'resume']);
  assert.ok(codex.includes('sandbox_mode="read-only"'));
  assert.deepEqual(codex.slice(-3), ['session', '--', req.prompt]);
  const claude = claudeArgs({}, req);
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(claude[claude.indexOf('--permission-prompts') + 1], 'none');
  assert.deepEqual(claude.slice(-2), ['--', req.prompt]);
  assert.ok(!codexArgs({ ignoreUserConfig: 'false' }, req).includes('--ignore-user-config'));
  assert.throws(() => codexArgs({ sandbox: 'danger-full-access' as any }, req));
  assert.throws(() => claudeArgs({ permissionMode: 'bypassPermissions' as any }, req));
});

test('permission modes keep plan/write restrictions and expose supported approvals', () => {
  assert.deepEqual(permissionSettings('claude-code', 'plan'), { permissionMode: 'plan' });
  assert.deepEqual(permissionSettings('claude-code', 'write'), { permissionMode: 'acceptEdits' });
  assert.deepEqual(permissionSettings('claude-code', 'ask'), { permissionMode: 'manual' });
  assert.deepEqual(permissionSettings('codex', 'write'), { sandbox: 'workspace-write' });
  assert.throws(() => permissionSettings('codex', 'ask'));
  assert.throws(() => permissionSettings('claude-code', 'bypass'));
  assert.deepEqual(permissionSettings('cmd', 'ask'), { permissionMode: 'yolo', approvals: true });
});

test('Claude manual permissions answer over stdio and retain the resolved model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-claude-approval-'));
  try {
    const binary = join(dir, 'approval.mjs');
    await writeFile(binary, `
      import {createInterface} from 'node:readline';
      for await (const line of createInterface({input:process.stdin})) {
        const frame=JSON.parse(line);
        if(frame.type==='user') console.log(JSON.stringify({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'test.txt',content:'approved'}}}));
        if(frame.type==='control_response') {
          console.log(JSON.stringify({type:'assistant',message:{model:'claude-opus-test',content:[]}}));
          console.log(JSON.stringify({type:'result',result:frame.response.response.behavior,session_id:'test-session'}));
        }
      }
    `);
    for (const decision of ['approve', 'deny'] as const) {
      const runner = new ClaudeCodeHarness({ binary, permissionMode: 'manual' });
      const events: AgentEvent[] = [];
      for await (const event of runner.run({ workspace: dir, prompt: 'Write a file' })) {
        events.push(event);
        if (event.type === 'approval_request') await runner.respondApproval(event.id, decision);
      }
      assert.equal((events.at(-1) as any).text, decision === 'approve' ? 'allow' : 'deny');
      assert.equal(runner.resolvedModel(), 'claude-opus-test');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('both JSONL adapters normalize text, tools, usage and exactly one terminal event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-clis-'));
  const binary = join(dir, 'fixture.mjs');
  try {
    for (const [Runner, frames] of [
      [CodexHarness, [
        { type: 'thread.started', thread_id: 'session-1' },
        { type: 'item.started', item: { type: 'command_execution', id: 'tool-1', command: 'pwd' } },
        { type: 'item.completed', item: { type: 'command_execution', id: 'tool-1', exit_code: 0 } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
      ]],
      [ClaudeCodeHarness, [
        { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hello' } } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
        { type: 'result', result: 'hello', session_id: 'session-1', usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01 },
      ]],
    ] as const) {
      await writeFile(binary, `console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n'))});`);
      const events = await collect(new Runner({ binary }).run({ workspace: dir, prompt: 'hello' }));
      assert.deepEqual(events.map(e => e.type).sort(), ['done', 'text', 'tool_end', 'tool_start', 'usage']);
      assert.deepEqual(events.at(-1), { type: 'done', exitCode: 0, text: 'hello', sessionId: 'session-1' });
    }
    await writeFile(binary, 'process.exit(2);');
    const failed = await collect(new CodexHarness({ binary }).run({ workspace: dir, prompt: '' }));
    assert.equal(failed.at(-1)?.type, 'done');
    assert.equal((failed.at(-1) as any).exitCode, 2);
    const missing = await collect(new CodexHarness({ binary: join(dir, 'missing') }).run({ workspace: dir, prompt: '' }));
    assert.equal(missing.filter(e => e.type === 'done').length, 1);
    assert.equal(missing.at(-1)?.type, 'done');
    await writeFile(binary, 'setInterval(() => {}, 1000);');
    const runningAbort = new AbortController();
    const runningTimer = setTimeout(() => runningAbort.abort(), 150);
    const stopped = await collect(new CodexHarness({ binary }).run({ workspace: dir, prompt: '' }, runningAbort.signal));
    clearTimeout(runningTimer);
    assert.equal((stopped.at(-1) as any).exitCode, 130);
    const abort = new AbortController(); abort.abort();
    const cancelled = await collect(new ClaudeCodeHarness({ binary }).run({ workspace: dir, prompt: '' }, abort.signal));
    assert.equal((cancelled.at(-1) as any).exitCode, 130);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('Codex keeps the structured model error instead of incidental stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-codex-error-'));
  try {
    const binary = join(dir, 'fixture.mjs');
    const message = JSON.stringify({type: 'error', status: 400, error: {
      message: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account." }});
    const frames = [{type: 'thread.started', thread_id: 'failed-session'},
      {type: 'error', message}, {type: 'turn.failed', error: {message}}];
    await writeFile(binary, `console.error('Reading additional input from stdin...');
      console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n'))}); process.exitCode=1;`);
    const events = await collect(new CodexHarness({binary}).run({workspace: dir, prompt: 'hello'}));
    const errors = events.filter(e => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /gpt-6-luna.*not supported/);
    assert.match(errors[0].message, /Clear Model/);
    assert.ok(!errors[0].message.includes('stdin'));
    assert.ok(!errors[0].message.includes('"status"'));
    assert.equal((events.at(-1) as any).exitCode, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
