import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCmdFrame, mapCmdEventFrame } from './cmd.ts';

test('parses the documented event frame shape', () => {
  const frame = parseCmdFrame(
    '{"type":"event","event":{"type":"tool_running","toolCallId":"abc","toolName":"read_file","description":"src/index.ts"}}',
  );
  assert.equal(frame?.kind, 'event');
  if (frame?.kind !== 'event') return;
  assert.equal(frame.event.toolName, 'read_file');
});

test('maps tool_running to a tool_start event', () => {
  assert.deepEqual(
    mapCmdEventFrame({ type: 'tool_running', toolCallId: 'abc', toolName: 'read_file', description: 'src/index.ts' }),
    { type: 'tool_start', name: 'read_file', detail: 'src/index.ts', toolCallId: 'abc' },
  );
});

test('maps a completed tool frame to a tool_end event', () => {
  assert.deepEqual(
    mapCmdEventFrame({ type: 'tool_completed', toolCallId: 'abc', toolName: 'read_file' }),
    { type: 'tool_end', name: 'read_file', detail: undefined, toolCallId: 'abc', ok: true },
  );
});

test('parses the terminal result frame', () => {
  const frame = parseCmdFrame(
    '{"type":"result","subtype":"success","sessionId":"s-1","stopReason":"end_turn","finalText":"hello","usage":{"input_tokens":10,"output_tokens":5},"durationMs":12}',
  );
  assert.equal(frame?.kind, 'result');
  if (frame?.kind !== 'result') return;
  assert.equal(frame.sessionId, 's-1');
  assert.equal(frame.stopReason, 'end_turn');
  assert.equal(frame.finalText, 'hello');
  assert.equal(frame.usage?.inputTokens, 10);
  assert.equal(frame.usage?.outputTokens, 5);
});

test('drops unknown, blank, and malformed frames', () => {
  assert.equal(parseCmdFrame('{"type":"telemetry","x":1}'), null);
  assert.equal(parseCmdFrame('not json'), null);
  assert.equal(parseCmdFrame('   '), null);
  assert.equal(mapCmdEventFrame({ type: 'some_future_frame' }), null);
});

test('maps streaming text deltas', () => {
  assert.deepEqual(mapCmdEventFrame({ type: 'text_delta', delta: 'hello' }), { type: 'text', text: 'hello' });
});

test('maps a queued tool call, using the command as the detail', () => {
  assert.deepEqual(
    mapCmdEventFrame({ type: 'tool_queued', toolCallId: 'c1', toolName: 'shell_command', input: { command: 'ls -la' } }),
    { type: 'tool_start', name: 'shell_command', detail: 'ls -la', toolCallId: 'c1' },
  );
});

test('maps a file tool call, using the path as the detail', () => {
  assert.deepEqual(
    mapCmdEventFrame({ type: 'tool_queued', toolCallId: 'c2', toolName: 'write_file', input: { file_path: 'a.txt' } }),
    { type: 'tool_start', name: 'write_file', detail: 'a.txt', toolCallId: 'c2' },
  );
});

test('maps a PreToolUse block to a failed tool_end', () => {
  assert.deepEqual(
    mapCmdEventFrame({
      type: 'tool_hook_blocked',
      toolCallId: 'c1',
      toolName: 'shell_command',
      hookOutput: 'denied by the operator',
    }),
    { type: 'tool_end', name: 'shell_command', detail: 'denied by the operator', ok: false, toolCallId: 'c1' },
  );
});
