#!/usr/bin/env node
// Node >= 22.6 runs this TypeScript directly (type stripping), so the npm `bin` shim works
// without a build step.
import { resolve } from 'node:path';
import { ConfigStore } from './core/config-store.ts';
import { SessionStore } from './core/session-store.ts';
import { WhatsAppChannel } from './channels/whatsapp/channel.ts';
import { OpenWaClient } from './channels/whatsapp/client.ts';
import { DashboardServer } from './dashboard/server.ts';
import { buildRunner, catalogEntry, resolveHarnessConfig, HARNESS_CATALOG, permissionSettings } from './harnesses/catalog.ts';

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
  let activeId = env('AGENT_BRIDGE_HARNESS') ?? config.activeHarness ?? 'cmd';

  const entry = catalogEntry(activeId);
  const resolved = resolveHarnessConfig(entry, config.harnessConfig(activeId));
  const runner = buildRunner(activeId, resolved.values);
  let runningValues = resolved.values;
  let bootSignature = JSON.stringify({ activeId, values: runningValues });

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
    control: {
      harnesses: HARNESS_CATALOG.map(entry => entry.manifest.id),
      model: () => typeof runningValues.model === 'string' ? runningValues.model : undefined,
      mode: () => `${runningValues.permissionMode ?? runningValues.sandbox ?? 'harness default'}${runningValues.approvals ? ' + chat approvals' : ''}`,
      select: async (id, model, mode) => {
        if (env('AGENT_BRIDGE_HARNESS') && id !== activeId) throw new Error('Harness is pinned by AGENT_BRIDGE_HARNESS.');
        const entry = catalogEntry(id);
        const saved = config.harnessConfig(id);
        if (mode !== undefined) {
          const patch = permissionSettings(id, mode);
          const pinned = resolveHarnessConfig(entry, saved).pinned;
          if (Object.keys(patch).some(key => pinned.includes(key))) throw new Error('Permission mode is pinned by an environment variable.');
          Object.assign(saved, patch);
        }
        if (model !== undefined) {
          if (!(entry.manifest.config?.properties as Record<string, unknown> | undefined)?.model) throw new Error('This harness has no model setting.');
          if (resolveHarnessConfig(entry, saved).pinned.includes('model')) throw new Error('Model is pinned by an environment variable.');
          if (model === 'default') delete saved.model;
          else saved.model = model;
        }
        const next = resolveHarnessConfig(entry, saved);
        const candidate = buildRunner(id, next.values);
        // Catalog visibility is not an entitlement check: verify explicit changes before saving.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let success = false;
        try {
          for await (const event of candidate.run({ prompt: 'Reply READY only. Do not use tools.', workspace }, controller.signal)) {
            if (event.type === 'done') success = event.exitCode === 0;
          }
          if (!success) throw new Error('Selected harness/model failed its readiness check; previous settings retained.');
        } finally { clearTimeout(timer); }
        const previousId = config.activeHarness;
        const previousValues = config.harnessConfig(id);
        config.setHarnessConfig(id, saved);
        config.setActiveHarness(id);
        try { await config.save(true); }
        catch (err) {
          config.setHarnessConfig(id, previousValues);
          config.setActiveHarness(previousId ?? activeId);
          throw err;
        }
        activeId = id;
        runningValues = next.values;
        bootSignature = JSON.stringify({ activeId, values: runningValues });
        return candidate;
      },
    },
  });

  // Chat controls update the running signature; other dashboard changes still need a restart.
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
