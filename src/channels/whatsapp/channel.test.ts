import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppChannel } from './channel.ts';
import { MockHarness } from '../../harnesses/mock.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { AgentEvent } from '../../core/events.ts';
import type { AgentRunner, HarnessCapabilities, RunRequest } from '../../core/runner.ts';
import type { MessagingClient, OpenWaWebhookEnvelope } from './types.ts';
import { commandModels, claudeModels } from '../../harnesses/models.ts';
import { incomingFile, outgoingFile } from './files.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELF = '917972833243@c.us';

test('native model parsers exclude headings and preserve model identifiers', () => {
  assert.deepEqual(commandModels('Available models  ·  2 models\nOpen Source\nmoonshotai/kimi-k3   fast (default)\nopenai/gpt-6-astra   reasoning'), ['moonshotai/kimi-k3', 'openai/gpt-6-astra']);
  assert.deepEqual(claudeModels("  --model <model> alias (e.g. 'fable', 'opus', or 'sonnet') or full name ('claude-fable-5')"), ['fable', 'opus', 'sonnet']);
  assert.deepEqual(claudeModels("  --model <model> Model. Provide\n        an alias (e.g.\n        'fable', 'opus', or 'sonnet')\n  --other 'wrong-alias'"), ['fable', 'opus', 'sonnet']);
});

test('file exchange confines paths and validates inbound encoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace);
    await writeFile(join(dir, 'outside.txt'), 'private');
    await writeFile(join(workspace, '.credentials'), 'secret');
    const path = await incomingFile(workspace, { mimetype: 'text/plain', filename: '../note.txt', data: Buffer.from('hello').toString('base64') });
    assert.equal(await readFile(path, 'utf8'), 'hello');
    assert.equal((await outgoingFile(workspace, path)).base64, 'aGVsbG8=');
    await assert.rejects(outgoingFile(workspace, '../outside.txt'));
    await assert.rejects(outgoingFile(workspace, '.credentials'));
    await assert.rejects(incomingFile(workspace, { mimetype: 'text/plain', data: 'bad encoding!' }));
    await assert.rejects(incomingFile(workspace, { mimetype: 'text/plain', omitted: true }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('chat commands select models and named threads without invoking the agent for commands', async () => {
  const client = new FakeClient();
  const requests: RunRequest[] = [];
  let selected: string | undefined;
  const runner: AgentRunner = { id: 'codex', capabilities: () => new MockHarness().capabilities(),
    listModels: async () => ['available-model'], async *run(req) {
      requests.push(req);
      yield { type: 'done', text: 'ok', exitCode: 0, sessionId: `session-${requests.length}` };
    } };
  const channel = new WhatsAppChannel({ runner, client, workspace: process.cwd(), log: () => {},
    control: { harnesses: ['codex'], model: () => selected, select: async (_id, model) => { selected = model; return runner; } } });
  let id = 0;
  for (const prompt of ['/models', '/model invalid', '/model available-model', '/new website', 'first', '/use default', 'second', '/use website', 'third']) {
    await channel.handle(envelope(`command-${++id}`, `@me ${prompt}`, false));
    await channel.idle();
  }
  assert.equal(selected, 'available-model');
  assert.equal(requests.length, 3);
  assert.equal(requests[2]?.sessionId, 'session-1');
  assert.ok(client.calls.some(call => call.includes('Unknown model')));
});

test('clarifications require a matching question and resume the same running turn', async () => {
  const client = new FakeClient();
  let answer: string | null | undefined;
  const runner: AgentRunner = { id: 'choice-test', capabilities: () => new MockHarness().capabilities(),
    respondChoice: async (_id, value) => { answer = value; }, async *run() {
      yield { type: 'choice_request', id: 'question-1', prompt: 'Pick one', options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] };
      yield { type: 'done', text: 'continued', exitCode: 0, sessionId: 'same-session' };
    } };
  const channel = new WhatsAppChannel({ runner, client, workspace: process.cwd(), log: () => {}, approvalTimeoutMs: 1000 });
  await channel.handle(envelope('question', '@me start', false));
  while (!client.calls.some(call => call.includes('/choose '))) await new Promise(resolve => setTimeout(resolve, 1));
  const questionId = /\/choose ([\w-]+)/.exec(client.calls.find(call => call.includes('/choose '))!)![1];
  await channel.handle(envelope('stale', '@me /choose old-question 1', false));
  assert.equal(answer, undefined);
  await channel.handle(envelope('answer', `@me /choose ${questionId} 2`, false));
  await channel.idle();
  assert.equal(answer, 'b');
  assert.ok(client.calls.some(call => call.includes('continued')));
});

class FakeClient implements MessagingClient {
  calls: string[] = [];
  #n = 0;

  async sendText(_sessionId: string, _chatId: string, text: string): Promise<{ messageId: string }> {
    this.#n += 1;
    const messageId = `sent-${this.#n}`;
    this.calls.push(`sendText:${text}`);
    return { messageId };
  }

  async editText(_sessionId: string, _chatId: string, messageId: string, body: string): Promise<{ messageId: string }> {
    this.calls.push(`editText:${messageId}:${body}`);
    return { messageId };
  }
}

function envelope(id: string, body: string, mentioned = true): OpenWaWebhookEnvelope {
  return {
    event: 'message.received',
    sessionId: 'sess-1',
    idempotencyKey: `idem-${id}`,
    data: {
      id,
      from: SELF,
      to: SELF,
      chatId: SELF,
      body,
      type: 'chat',
      timestamp: 1,
      fromMe: true,
      isGroup: false,
      kind: 'individual',
      mentionedIds: mentioned ? [SELF] : [],
    },
  };
}

function channelWith(client: FakeClient): WhatsAppChannel {
  return new WhatsAppChannel({
    runner: new MockHarness(),
    client,
    workspace: process.cwd(),
    progressThrottleMs: 0,
    log: () => {},
  });
}

const selfNumber = SELF.split('@')[0] as string;

test('switching harnesses isolates sessions and preserves legacy cmd history', async () => {
  const sessions = new SessionStore();
  sessions.remember(SELF, 'legacy-cmd');
  for (const [id, expected] of [['codex', undefined], ['claude-code', undefined], ['cmd', 'legacy-cmd'], ['codex', 'codex-session']] as const) {
    let resumed: string | undefined;
    const runner: AgentRunner = {
      id, capabilities: () => new MockHarness().capabilities(),
      async *run(req) {
        resumed = req.sessionId;
        yield { type: 'done', exitCode: 0, text: 'ok', sessionId: `${id}-session` };
      },
    };
    const channel = new WhatsAppChannel({ runner, sessions, client: new FakeClient(),
      workspace: process.cwd(), log: () => {} });
    await channel.handle(envelope(`switch-${id}`, '@me hello', false));
    await channel.idle();
    assert.equal(resumed, expected);
  }
  assert.equal(sessions.get('claude-code:' + SELF)?.sessionId, 'claude-code-session');
});

test('a self-chat mention runs the harness and streams progress into one message', async () => {
  const client = new FakeClient();
  const channel = channelWith(client);

  await channel.handle(envelope('m1', `@${selfNumber} hello`));
  await channel.idle();

  assert.equal(client.calls[0], 'sendText:👾 *Agent · mock*\n\nworking...');
  assert.ok(client.calls.some(call => call.startsWith('editText:sent-1:')), 'the placeholder is edited');
  assert.ok(client.calls.some(call => call.includes('echo: hello')), 'the harness answer lands in the chat');
});

test('acknowledges only accepted triggers and clears typing even when delivery fails', async () => {
  const client = new FakeClient();
  const activity: string[] = [];
  Object.assign(client, {
    react: async (_s: string, _c: string, id: string, emoji: string) => { activity.push(`react:${id}:${emoji}`); },
    sendChatState: async (_s: string, _c: string, state: string) => { activity.push(state); },
  });
  const channel = channelWith(client);
  await channel.handle(envelope('note', 'my note', false));
  await channel.handle(envelope('trigger', '@me hello', false));
  await channel.idle();
  await channel.handle(envelope('trigger', '@me hello', false));
  assert.deepEqual(activity, ['react:trigger:👾', 'typing', 'paused']);
  assert.ok(client.calls.filter(call => call.startsWith('sendText:') || call.startsWith('editText:'))
    .every(call => call.includes('*Agent · mock*')));
  client.sendText = async () => { throw new Error('offline'); };
  await channel.handle(envelope('failure', '@me hello', false));
  await channel.idle();
  assert.deepEqual(activity.slice(-3), ['react:failure:👾', 'typing', 'paused']);
});

test('cosmetic API failures do not prevent an agent reply', async () => {
  const client = new FakeClient();
  Object.assign(client, {
    react: async () => { throw new Error('reaction unavailable'); },
    sendChatState: async () => { throw new Error('presence unavailable'); },
  });
  const channel = channelWith(client);
  await channel.handle(envelope('trigger', '@me hello', false));
  await channel.idle();
  assert.ok(client.calls.some(call => call.includes('echo: hello')));
});

test('a message without a mention or @me is ignored', async () => {
  const client = new FakeClient();
  const channel = channelWith(client);

  await channel.handle(envelope('m2', 'just a note to myself', false));
  await channel.idle();

  assert.deepEqual(client.calls, []);
});

test('the same idempotency key is only acted on once', async () => {
  const client = new FakeClient();
  const channel = channelWith(client);
  const env = envelope('m3', `@${selfNumber} do the thing`);

  await channel.handle(env);
  await channel.idle();
  const afterFirst = client.calls.length;

  await channel.handle(env);
  await channel.idle();

  assert.equal(client.calls.length, afterFirst);
});

test('API-originated self-chat triggers run once across sent and received events', async () => {
  const client = new FakeClient();
  const channel = channelWith(client);
  const sent = { ...envelope('api-message', '@me hello', false), event: 'message.sent' };
  await channel.handle(sent);
  await channel.idle();
  const count = client.calls.length;
  await channel.handle({ ...sent, event: 'message.received', idempotencyKey: 'different-event-key' });
  await channel.idle();
  assert.ok(client.calls.some(call => call.includes('echo: hello')));
  assert.equal(client.calls.length, count);
});

test('an echo of a message the bridge sent can never start a run', async () => {
  const client = new FakeClient();
  const channel = channelWith(client);

  await channel.handle(envelope('m4', `@${selfNumber} first`));
  await channel.idle();
  const afterFirst = client.calls.length;

  // 'sent-1' is the placeholder this bridge posted; it comes back as a mention but must not run.
  await channel.handle(envelope('sent-1', `@${selfNumber} second`));
  await channel.idle();

  assert.equal(client.calls.length, afterFirst);
});

// --- approval transport -------------------------------------------------------------------

/** A harness that asks for approval and blocks until the chat answers. */
class ApprovalHarness implements AgentRunner {
  readonly id = 'approval';
  decisions: string[] = [];
  aborted = false;
  #prompts: string[];
  #deferred?: (decision: string) => void;
  #decision?: string;

  constructor(prompts: string[] = ['Deploy to production?']) {
    this.#prompts = prompts;
  }

  capabilities(): HarnessCapabilities {
    return { streaming: true, resume: false, approvals: true, nativeMcp: false, reportsCost: false };
  }

  async respondApproval(_id: string, decision: 'approve' | 'deny'): Promise<void> {
    this.decisions.push(decision);
    this.#decision = decision;
    this.#deferred?.(decision);
  }

  async *run(_req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    signal?.addEventListener('abort', () => {
      this.aborted = true;
    });

    const answers: string[] = [];
    for (const prompt of this.#prompts) {
      if (signal?.aborted) break;
      yield { type: 'approval_request', id: `a${answers.length + 1}`, prompt };

      let decision = this.#decision;
      this.#decision = undefined;
      if (decision === undefined) {
        decision = await new Promise<string>(resolve => {
          this.#deferred = resolve;
        });
      }
      this.#deferred = undefined;
      answers.push(decision);
    }

    yield { type: 'done', exitCode: 0, text: `decisions: ${answers.join(',')}` };
  }
}

/** A harness that asks for approval but offers no way to answer it. */
class UnanswerableHarness implements AgentRunner {
  readonly id = 'unanswerable';

  capabilities(): HarnessCapabilities {
    return { streaming: true, resume: false, approvals: false, nativeMcp: false, reportsCost: false };
  }

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: 'approval_request', id: 'a1', prompt: 'Delete the database?' };
    yield { type: 'done', exitCode: 0, text: 'continued anyway' };
  }
}

function approvalChannel(runner: AgentRunner, client: FakeClient, approvalTimeoutMs = 1000): WhatsAppChannel {
  return new WhatsAppChannel({
    runner,
    client,
    workspace: process.cwd(),
    progressThrottleMs: 0,
    approvalTimeoutMs,
    log: () => {},
  });
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 5));
  }
}

test('an approval request parks the run until the operator replies yes', async () => {
  const client = new FakeClient();
  const harness = new ApprovalHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await until(() => client.calls.some(call => call.includes('approval needed')));

  await channel.handle(envelope('m2', 'yes', false));
  await channel.idle();

  assert.deepEqual(harness.decisions, ['approve']);
  assert.ok(client.calls.some(call => call.includes('decisions: approve')));
});

test('replying no denies the approval', async () => {
  const client = new FakeClient();
  const harness = new ApprovalHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await until(() => client.calls.some(call => call.includes('approval needed')));

  await channel.handle(envelope('m2', 'no', false));
  await channel.idle();

  assert.deepEqual(harness.decisions, ['deny']);
});

test('an unrecognized reply re-prompts and leaves the run waiting', async () => {
  const client = new FakeClient();
  const harness = new ApprovalHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await until(() => client.calls.some(call => call.includes('approval needed')));

  await channel.handle(envelope('m2', 'what will it actually do?', false));
  await until(() => client.calls.some(call => call.includes('still waiting for approval')));
  assert.deepEqual(harness.decisions, [], 'the run is still parked');

  await channel.handle(envelope('m3', 'yes', false));
  await channel.idle();
  assert.deepEqual(harness.decisions, ['approve']);
});

test('an unanswered approval times out as a deny — never a silent approval', async () => {
  const client = new FakeClient();
  const harness = new ApprovalHarness();
  const channel = approvalChannel(harness, client, 30);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await channel.idle();

  assert.deepEqual(harness.decisions, ['deny']);
});

test('cancel denies the approval and aborts the run', async () => {
  const client = new FakeClient();
  const harness = new ApprovalHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await until(() => client.calls.some(call => call.includes('approval needed')));

  await channel.handle(envelope('m2', 'cancel', false));
  await channel.idle();

  assert.deepEqual(harness.decisions, ['deny']);
  assert.equal(harness.aborted, true);
  assert.ok(client.calls.some(call => call.includes('cancelled')));
});

test('a harness that cannot answer an approval does not deadlock the run', async () => {
  const client = new FakeClient();
  const channel = approvalChannel(new UnanswerableHarness(), client);

  await channel.handle(envelope('m1', `@${selfNumber} deploy`));
  await channel.idle();

  assert.ok(client.calls.some(call => call.includes('not answerable')));
  assert.ok(client.calls.some(call => call.includes('continued anyway')));
});

// --- session routing ----------------------------------------------------------------------

/** A harness that resumes when given a session and reports a stable session id. */
class SessionHarness implements AgentRunner {
  readonly id = 'session';
  requests: RunRequest[] = [];
  turns = 0;
  #sessionId?: string;

  capabilities(): HarnessCapabilities {
    return { streaming: true, resume: true, approvals: false, nativeMcp: false, reportsCost: false };
  }

  async *run(req: RunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(req);
    this.turns += 1;
    this.#sessionId = req.sessionId ?? `session-${this.turns}`;
    const text = `turn ${this.turns}`;
    yield { type: 'text', text };
    yield { type: 'done', exitCode: 0, text, sessionId: this.#sessionId };
  }
}

/** A harness that reports a session but cannot be resumed. */
class NoResumeHarness implements AgentRunner {
  readonly id = 'no-resume';
  requests: RunRequest[] = [];

  capabilities(): HarnessCapabilities {
    return { streaming: true, resume: false, approvals: false, nativeMcp: false, reportsCost: false };
  }

  async *run(req: RunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(req);
    yield { type: 'done', exitCode: 0, text: 'ok', sessionId: 'server-side-session' };
  }
}

test('a chat resumes its harness session on the next message', async () => {
  const client = new FakeClient();
  const harness = new SessionHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} first`));
  await channel.idle();
  await channel.handle(envelope('m2', `@${selfNumber} second`));
  await channel.idle();

  assert.equal(harness.requests[0]?.sessionId, undefined, 'the first message starts a session');
  assert.equal(harness.requests[1]?.sessionId, 'session-1', 'the second message resumes it');
});

test('the session is announced once, when it begins', async () => {
  const client = new FakeClient();
  const channel = approvalChannel(new SessionHarness(), client);

  await channel.handle(envelope('m1', `@${selfNumber} first`));
  await channel.idle();
  assert.ok(client.calls.some(call => call.includes('this chat continues from your next message')));

  const afterFirst = client.calls.length;
  await channel.handle(envelope('m2', `@${selfNumber} second`));
  await channel.idle();

  const laterCalls = client.calls.slice(afterFirst).join('\n');
  assert.ok(!laterCalls.includes('this chat continues'), 'no repeat announcement on a resumed turn');
});

test('"new" forgets the session so the next message starts fresh', async () => {
  const client = new FakeClient();
  const harness = new SessionHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} first`));
  await channel.idle();
  await channel.handle(envelope('m2', `@${selfNumber} new`));
  await channel.idle();
  await channel.handle(envelope('m3', `@${selfNumber} third`));
  await channel.idle();

  assert.equal(harness.requests.length, 2, 'the control word did not run the harness');
  assert.equal(harness.requests[1]?.sessionId, undefined, 'the session was forgotten');
});

test('"session" reports the current session without running the harness', async () => {
  const client = new FakeClient();
  const harness = new SessionHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} first`));
  await channel.idle();
  await channel.handle(envelope('m2', `@${selfNumber} session`));
  await channel.idle();

  assert.equal(harness.requests.length, 1);
  assert.ok(client.calls.some(call => call.includes('current session: session-1')));
});

test('a harness that cannot resume is never handed a sessionId', async () => {
  const client = new FakeClient();
  const harness = new NoResumeHarness();
  const channel = approvalChannel(harness, client);

  await channel.handle(envelope('m1', `@${selfNumber} first`));
  await channel.idle();
  await channel.handle(envelope('m2', `@${selfNumber} second`));
  await channel.idle();

  assert.deepEqual(harness.requests.map(r => r.sessionId), [undefined, undefined]);
});


test('a failed first turn does not persist or announce its session', async () => {
  const sessions = new SessionStore(), client = new FakeClient();
  const runner: AgentRunner = { id: 'codex', capabilities: () => new MockHarness().capabilities(),
    async *run() {
      yield { type: 'error', message: 'model not supported' };
      yield { type: 'done', exitCode: 1, text: '', sessionId: 'failed-session' };
    } };
  const channel = new WhatsAppChannel({runner, sessions, client, workspace: process.cwd(), log: () => {}});
  await channel.handle(envelope('failed', '@me hello', false)); await channel.idle();
  assert.equal(sessions.size, 0);
  assert.ok(client.calls.at(-1)?.includes('model not supported'));
  assert.ok(!client.calls.join('\n').includes('this chat continues'));
});
