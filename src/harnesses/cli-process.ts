import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../core/events.ts';
import type { RunRequest } from '../core/runner.ts';
import { tryParseJson } from '../core/ndjson.ts';

/** Shared lifecycle for JSONL CLIs. Prompts never pass through a shell. */
export async function* runProcess(
  binary: string, args: string[], req: RunRequest,
  map: (frame: any) => AgentEvent[], signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  let text = '', sessionId = req.sessionId, stderr = '', failure: Error | undefined;
  let terminal: Extract<AgentEvent, { type: 'done' }> | undefined;
  if (signal?.aborted) {
    yield { type: 'done', exitCode: 130, text: '', sessionId };
    return;
  }
  const script = /\.(mjs|cjs|js)$/i.test(binary);
  const child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : args, {
    cwd: req.workspace, env: { ...process.env, ...req.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('error', err => { failure = err; });
  const closed = new Promise<number>(resolve => child.once('close', (code, sig) => resolve(code ?? (sig ? 130 : 1))));
  const abort = () => { child.kill('SIGTERM'); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const frame = tryParseJson(line);
      if (!frame || typeof frame !== 'object') continue;
      for (const event of map(frame)) {
        if (event.type === 'done') { terminal = event; sessionId = event.sessionId ?? sessionId; }
        else { if (event.type === 'text') text += event.text; yield event; }
      }
    }
    const code = await closed;
    if (failure) throw failure;
    if (code !== 0 && stderr.trim()) yield { type: 'error', message: stderr.trim() };
    if (!terminal && !signal?.aborted) yield { type: 'error', message: 'CLI exited without a terminal result' };
    yield { type: 'done', exitCode: code || terminal?.exitCode || (terminal ? 0 : 1),
      text: terminal?.text || text, sessionId };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    yield { type: 'done', exitCode: 1, text, sessionId };
  } finally {
    signal?.removeEventListener('abort', abort);
    child.kill();
  }
}
