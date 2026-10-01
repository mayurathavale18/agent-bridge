#!/usr/bin/env node
// Node >= 22.6 runs this TypeScript directly (type stripping), so the npm `bin` shim works
// without a build step.
import { resolve } from 'node:path';
import { ConfigStore } from './core/config-store.ts';
import { SessionStore } from './core/session-store.ts';
import { WhatsAppChannel } from './channels/whatsapp/channel.ts';
import { OpenWaClient } from './channels/whatsapp/client.ts';
import { DashboardServer } from './dashboard/server.ts';
import { buildRunner, catalogEntry, resolveHarnessConfig } from './harnesses/catalog.ts';

const env = (name: string, fallback?: string): string | undefined => {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
};

async function main(): Promise<void> {
  const apiKey = env('OPENWA_API_KEY');
  if (!apiKey) {
    process.stderr.write('OPENWA_API_KEY is required (see the gateway dashboard or data/.api-key)\n');
    process.exitCode = 1;
    return;
  }

  const workspace = resolve(env('AGENT_BRIDGE_WORKSPACE', process.cwd()) as string);

  // Selection precedence: an explicit AGENT_BRIDGE_HARNESS pins, else whatever the dashboard saved.
  const config = new ConfigStore({ file: env('AGENT_BRIDGE_CONFIG_FILE') });
  await config.load();
  const activeId = env('AGENT_BRIDGE_HARNESS') ?? config.activeHarness ?? 'cmd';

  const entry = catalogEntry(activeId);
  const resolved = resolveHarnessConfig(entry, config.harnessConfig(activeId));
  const runner = buildRunner(activeId, resolved.values);

  const sessions = new SessionStore({ file: env('AGENT_BRIDGE_SESSION_FILE') });
  await sessions.load();

  const client = new OpenWaClient({
    baseUrl: env('OPENWA_BASE_URL', 'http://127.0.0.1:2785') as string,
    apiKey,
    timeoutMs: Number(env('OPENWA_TIMEOUT_MS', '15000')),
  });

  const channel = new WhatsAppChannel({
    runner,
    client,
    workspace,
    webhookSecret: env('OPENWA_WEBHOOK_SECRET'),
    sessionId: env('OPENWA_SESSION_ID'),
    selfJid: env('OPENWA_SELF_JID'),
    progressThrottleMs: Number(env('AGENT_BRIDGE_PROGRESS_MS', '1200')),
    approvalTimeoutMs: Number(env('AGENT_BRIDGE_APPROVAL_TIMEOUT_MS', '120000')),
    sessions,
  });

  // The running harness is built once at boot, so the dashboard says plainly when saved changes
  // are waiting on a restart rather than appearing to have no effect.
  const bootSignature = JSON.stringify({ activeId, values: resolved.values });
  const dashboard = new DashboardServer({
    config,
    workspace,
    restart: env('AGENT_BRIDGE_ALLOW_RESTART') === 'true' ? () => {
      webhookServer.close();
      void channel.idle().finally(() => process.exit(0));
    } : undefined,
    statusLine: () => {
      try {
        const id = config.activeHarness ?? activeId;
        const now = resolveHarnessConfig(catalogEntry(id), config.harnessConfig(id));
        const parts: string[] = [];
        if (JSON.stringify({ activeId: id, values: now.values }) !== bootSignature) parts.push('changed — restart to apply');
        if (now.pinned.length > 0) parts.push(`pinned by env: ${now.pinned.join(', ')}`);
        return parts.join(' · ');
      } catch {
        return '';
      }
    },
  });

  const port = Number(env('WA_PORT', '8788'));
  const host = env('WA_HOST', '127.0.0.1') as string;
  const webhookServer = channel.start(port, host);

  const dashboardPort = Number(env('DASHBOARD_PORT', '8789'));
  const dashboardHost = env('DASHBOARD_HOST', '127.0.0.1') as string;
  dashboard.start(dashboardPort, dashboardHost);

  process.stdout.write(`harness: ${activeId}  workspace: ${workspace}\n`);
  if (resolved.pinned.length > 0) process.stdout.write(`pinned by env: ${resolved.pinned.join(', ')}\n`);
  process.stdout.write(`point the OpenWA webhook at http://${host}:${port}/webhook\n`);
  process.stdout.write(`dashboard: http://${dashboardHost}:${dashboardPort}\n`);
  if (!env('OPENWA_WEBHOOK_SECRET')) {
    process.stdout.write('WARNING: OPENWA_WEBHOOK_SECRET is unset — webhook signatures are NOT verified.\n');
  }

  const shutdown = (): void => {
    void channel.idle().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
