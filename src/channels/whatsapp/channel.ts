import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from 'node:http';
import type { AgentRunner, RunRequest } from '../../core/runner.ts';
import { SessionStore } from '../../core/session-store.ts';
import { APPROVAL_HINT, parseApprovalAnswer, type ApprovalDecision, type PendingApproval } from './approval.ts';
import { COMMAND_HELP, parseChatCommand, type ChatCommand } from './commands.ts';
import { chunkText, formatProgress, WHATSAPP_TEXT_LIMIT } from './renderer.ts';
import { verifySignature } from './signature.ts';
import { EchoGuard, extractTrigger, isSelfChat, selfIdSet } from './trigger.ts';
import type { MessagingClient, OpenWaWebhookEnvelope } from './types.ts';

export interface WhatsAppChannelOptions {
  runner: AgentRunner;
  client: MessagingClient;
  /** Working directory handed to the harness for every run. */
  workspace: string;
  /** When set, webhooks must carry a valid `X-OpenWA-Signature`. Strongly recommended. */
  webhookSecret?: string;
  /** Force a session id instead of trusting the one in the payload. */
  sessionId?: string;
  /** The account's own JID, when it should not be derived from the message. */
  selfJid?: string;
  maxChars?: number;
  /** Minimum gap between message edits, in ms — WhatsApp dislikes rapid edits. */
  progressThrottleMs?: number;
  /** How long to wait for an approval reply before auto-denying. Default 120000. */
  approvalTimeoutMs?: number;
  /** Chat -> harness session map, so a chat continues across messages. */
  sessions?: SessionStore;
  log?: (message: string) => void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The WhatsApp channel: receives OpenWA webhooks, decides whether a message is a trigger,
 * runs the harness, and streams the result back into the chat by editing one message.
 *
 * Security posture: signature-verified, idempotency-deduped, self-chat only, mention-gated,
 * and single-flight per chat. A message the bridge itself posted can never start a run.
 */
export class WhatsAppChannel {
  #runner: AgentRunner;
  #client: MessagingClient;
  #workspace: string;
  #secret: string | undefined;
  #sessionOverride: string | undefined;
  #selfJid: string | undefined;
  #maxChars: number;
  #throttleMs: number;
  #approvalTimeoutMs: number;
  #sessions: SessionStore;
  #log: (message: string) => void;
  #echo = new EchoGuard();
  #seen = new Map<string, true>();
  #queues = new Map<string, Promise<void>>();
  /** One pending approval per chat — single-flight guarantees at most one waiting run. */
  #approvals = new Map<string, PendingApproval>();
  #aborts = new Map<string, AbortController>();

  constructor(opts: WhatsAppChannelOptions) {
    this.#runner = opts.runner;
    this.#client = opts.client;
    this.#workspace = opts.workspace;
    this.#secret = opts.webhookSecret;
    this.#sessionOverride = opts.sessionId;
    this.#selfJid = opts.selfJid;
    this.#maxChars = opts.maxChars ?? WHATSAPP_TEXT_LIMIT;
    this.#throttleMs = opts.progressThrottleMs ?? 1200;
    this.#approvalTimeoutMs = opts.approvalTimeoutMs ?? 120_000;
    this.#sessions = opts.sessions ?? new SessionStore();
    this.#log = opts.log ?? (message => process.stdout.write(`[whatsapp] ${message}\n`));
  }

  /** Process one (already verified) envelope. Public so tests can drive it without HTTP. */
  async handle(envelope: OpenWaWebhookEnvelope): Promise<void> {
    if (envelope.event !== 'message.received' && envelope.event !== 'message.sent') return;

    const duplicateKey = envelope.data.id
      ? `${envelope.sessionId}:${envelope.data.id}` : envelope.idempotencyKey;
    if (duplicateKey && this.#isDuplicate(duplicateKey)) return;

    const message = envelope.data;
    const sessionId = this.#sessionOverride ?? envelope.sessionId;

    // A chat parked on an approval: this message is the answer, not a new instruction.
    // Checked BEFORE trigger extraction so a plain "yes"/"no" needs no mention.
    const pending = this.#approvals.get(message.chatId);
    if (pending) {
      if (!isSelfChat(message, selfIdSet(this.#selfJid)) || this.#echo.isEcho(message.id)) return;

      const answer = parseApprovalAnswer(message.body);
      if (!answer) {
        // Never guess on an approval: re-prompt and leave the run waiting.
        await this.#notice(sessionId, message.chatId, `still waiting for approval — ${APPROVAL_HINT}`);
        return;
      }

      this.#log(`approval "${answer}" for ${message.chatId}`);
      pending.settle(answer);
      return;
    }

    const trigger = extractTrigger(message, { selfJid: this.#selfJid });
    if (!trigger) return;
    if (this.#echo.isEcho(trigger.messageId)) return;

    await this.#client.react?.(sessionId, trigger.chatId, trigger.messageId, '👾')
      .catch(err => this.#log(`reaction failed: ${errText(err)}`));

    // Chat control words are queued like a run, so `new` cannot overtake an in-flight turn.
    const command = parseChatCommand(trigger.prompt);
    if (command) {
      this.#enqueue(trigger.chatId, () => this.#handleCommand(sessionId, trigger.chatId, command));
      return;
    }

    this.#log(`trigger from ${trigger.chatId}: ${trigger.prompt.slice(0, 80)}`);
    this.#enqueue(trigger.chatId, () => this.#run(sessionId, trigger.chatId, trigger.prompt));
  }

  async #handleCommand(sessionId: string, chatId: string, command: ChatCommand): Promise<void> {
    if (command === 'new') {
      this.#sessions.clear(chatId);
      this.#log(`session cleared for ${chatId}`);
      await this.#notice(sessionId, chatId, `started a new session — the next message begins fresh.\n${COMMAND_HELP}`);
      return;
    }

    const record = this.#sessions.get(chatId);
    await this.#notice(
      sessionId,
      chatId,
      record
        ? `current session: ${record.sessionId}`
        : `no session yet — the next message starts one.\n${COMMAND_HELP}`,
    );
  }

  /** Node http handler. Verifies the signature, ACKs fast, then works asynchronously. */
  handler = async (req: HttpRequest, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }

    const raw = await readBody(req);

    if (this.#secret) {
      const header = req.headers['x-openwa-signature'];
      if (!verifySignature(this.#secret, raw, typeof header === 'string' ? header : undefined)) {
        this.#log('rejected webhook: bad or missing signature');
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"invalid signature"}');
        return;
      }
    }

    // ACK before doing any work: OpenWA retries a webhook that does not answer promptly.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');

    let envelope: OpenWaWebhookEnvelope;
    try {
      envelope = JSON.parse(raw.toString('utf8')) as OpenWaWebhookEnvelope;
    } catch {
      this.#log('ignoring webhook with unparseable body');
      return;
    }
    void this.handle(envelope).catch(err => this.#log(`handle failed: ${errText(err)}`));
  };

  start(port: number, host = '127.0.0.1'): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
      void this.handler(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.listen(port, host, () => this.#log(`listening on http://${host}:${port}/webhook`));
    return server;
  }

  /** Resolve once every queued run has settled. Used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }

  async #run(sessionId: string, chatId: string, prompt: string): Promise<void> {
    const presence = async (state: 'typing' | 'paused'): Promise<void> => {
      await this.#client.sendChatState?.(sessionId, chatId, state)
        .catch(err => this.#log(`presence failed: ${errText(err)}`));
    };
    await presence('typing');
    const timer = setInterval(() => { void presence('typing'); }, 3000);
    try {
      await this.#runTurn(sessionId, chatId, prompt);
    } finally {
      clearInterval(timer);
      await presence('paused');
    }
  }

  #label(text: string): string {
    return `👾 *Agent · ${this.#runner.id}*\n\n${text}`;
  }

  async #runTurn(sessionId: string, chatId: string, prompt: string): Promise<void> {
    const client = this.#client;
    let placeholderId: string;
    try {
      const placeholder = await client.sendText(sessionId, chatId, this.#label('working...'));
      placeholderId = placeholder.messageId;
      this.#echo.remember(placeholderId);
    } catch (err) {
      this.#log(`could not send placeholder to ${chatId}: ${errText(err)}`);
      return;
    }

    let lastEdit = 0;
    let latest = 'working...';
    let streamed = '';
    let finalText: string | undefined;
    let reportedSession: string | undefined;

    const present = async (body: string, force: boolean): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastEdit < this.#throttleMs) return;
      lastEdit = now;
      const safe = body.trim() || '(no output)';
      const headerLength = this.#label('').length;
      const chunks = chunkText(safe.slice(0, this.#maxChars * 20), Math.max(1, this.#maxChars - headerLength))
        .map(chunk => this.#label(chunk));
      try {
        await client.editText(sessionId, chatId, placeholderId, chunks[0] ?? safe);
        for (const extra of chunks.slice(1)) {
          const sent = await client.sendText(sessionId, chatId, extra);
          this.#echo.remember(sent.messageId);
        }
      } catch (err) {
        this.#log(`could not update message in ${chatId}: ${errText(err)}`);
      }
    };

    // Continue this chat's session when the harness can resume; otherwise every message is a
    // fresh run and the chat has no memory.
    const canResume = this.#runner.capabilities().resume;
    const previousSession = canResume ? this.#sessions.get(chatId)?.sessionId : undefined;
    const request: RunRequest = { prompt, workspace: this.#workspace, sessionId: previousSession };
    const controller = new AbortController();
    this.#aborts.set(chatId, controller);
    let cancelled = false;

    try {
      for await (const event of this.#runner.run(request, controller.signal)) {
        if (event.type === 'text') streamed += event.text;

        if (event.type === 'approval_request') {
          if (!this.#runner.respondApproval) {
            // No way to answer it, so do not park the run — surface it and move on.
            this.#log(`harness asked for approval but implements no respondApproval: ${event.prompt}`);
            latest = `approval needed: ${event.prompt} (not answerable — harness has no approval transport)`;
            await present(latest, true);
            continue;
          }

          await present(`approval needed: ${event.prompt}\n${APPROVAL_HINT}`, true);
          const decision = await this.#awaitApproval(chatId, event.id, event.prompt);

          await this.#runner.respondApproval(
            event.id,
            decision === 'approve' ? 'approve' : 'deny',
            decision === 'cancel' ? 'cancelled by the operator' : undefined,
          );

          if (decision === 'cancel') {
            cancelled = true;
            controller.abort();
            await present('cancelled', true);
          } else {
            await present(decision === 'approve' ? 'approved — continuing...' : 'denied', true);
          }
          continue;
        }

        const line = formatProgress(event);
        if (line) {
          latest = line;
          await present(line, false);
        }

        if (event.type === 'done') {
          finalText = event.text || streamed || (event.exitCode !== 0 ? latest : '(no output)');
          if (event.sessionId) reportedSession = event.sessionId;
        }
      }
    } catch (err) {
      // An aborted run commonly throws; report the cancellation, not a bogus failure.
      finalText = cancelled ? 'cancelled' : `error: ${errText(err)}`;
    } finally {
      this.#aborts.delete(chatId);
    }

    let note: string | undefined;
    if (reportedSession && reportedSession !== previousSession) {
      this.#sessions.remember(chatId, reportedSession);
      // Say it once, when a session begins; after that, continuity is silent.
      note = `session ${reportedSession.slice(0, 8)} — this chat continues from your next message.`;
    }
    const answer = finalText ?? latest;
    await present(note ? `${answer}\n\n${note}` : answer, true);
  }

  /**
   * Park the run until the operator answers in the chat, or the timeout fires. Resolving a
   * `deny` on timeout is the safe default: an unanswered approval must not become an approval.
   */
  #awaitApproval(chatId: string, approvalId: string, prompt: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#approvals.delete(chatId);
        resolve(decision);
      };

      timer = setTimeout(() => {
        this.#log(`approval for ${chatId} timed out after ${this.#approvalTimeoutMs}ms — denying`);
        settle('deny');
      }, this.#approvalTimeoutMs);

      this.#approvals.set(chatId, { id: approvalId, prompt, settle });
    });
  }

  async #notice(sessionId: string, chatId: string, text: string): Promise<void> {
    try {
      const sent = await this.#client.sendText(sessionId, chatId, this.#label(text));
      this.#echo.remember(sent.messageId);
    } catch (err) {
      this.#log(`could not send notice to ${chatId}: ${errText(err)}`);
    }
  }

  #enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task).catch(err => this.#log(`queued run failed: ${errText(err)}`));
    this.#queues.set(key, next);
    void next.then(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
  }

  #isDuplicate(key: string): boolean {
    if (this.#seen.has(key)) return true;
    this.#seen.set(key, true);
    if (this.#seen.size > 1000) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return false;
  }
}

async function readBody(req: HttpRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
