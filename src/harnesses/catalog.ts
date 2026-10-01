import { envOverrides, schemaDefaults } from '../core/config-schema.ts';
import type { HarnessManifest } from '../core/manifest.ts';
import type { AgentRunner } from '../core/runner.ts';
import { CmdHarness, type CmdConfig } from './cmd.ts';
import { CodexHarness, type CodexConfig } from './codex.ts';
import { ClaudeCodeHarness, type ClaudeCodeConfig } from './claude-code.ts';
import { HttpHarness } from './http.ts';
import { MockHarness } from './mock.ts';

export interface CatalogEntry {
  manifest: HarnessManifest;
  /** Build the runner from fully resolved config. */
  create: (config: Record<string, unknown>) => AgentRunner;
}

/**
 * Built-in harnesses. The `config` schema on each manifest is the single source of truth for
 * both the dashboard form and the environment-override names — add a property here and it
 * appears in the UI with no other change.
 */
export const CMD_MANIFEST: HarnessManifest = {
  id: 'cmd',
  name: 'Command Code',
  version: '1.0.0',
  kind: 'native',
  capabilities: { streaming: true, resume: true, approvals: true, nativeMcp: true, reportsCost: true },
  config: {
    type: 'object',
    properties: {
      binary: {
        type: 'string',
        default: 'cmdc',
        title: 'Executable',
        description: 'cmdc, or a path. A .mjs path is run through node (the portable way on Windows).',
      },
      model: {
        type: 'string',
        title: 'Model',
        description: 'e.g. claude-sonnet-5, gpt-6-luna, or a BYOK id like openrouter/…',
      },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], title: 'Reasoning effort' },
      maxTurns: { type: 'number', default: 100, title: 'Max turns' },
      permissionMode: {
        type: 'string',
        enum: ['standard', 'plan', 'accept-edits', 'yolo'],
        default: 'standard',
        title: 'Permission mode',
        description: 'standard blocks writes and shell; accept-edits allows file changes.',
      },
      approvals: {
        type: 'boolean',
        default: false,
        title: 'Gate tools behind chat approval',
        description: 'Park every shell/write/edit call until you answer in the chat.',
      },
      approvalTimeoutSeconds: {
        type: 'number',
        default: 600,
        title: 'Approval hook timeout (s)',
        description: "Command Code's own hook timeout. Must exceed the channel's reply window.",
      },
    },
  },
  metadata: { docs: 'https://commandcode.ai/docs' },
};

export const CODEX_MANIFEST: HarnessManifest = {
  id: 'codex', name: 'Codex', version: '1.0.0', kind: 'native',
  capabilities: { streaming: true, resume: true, approvals: false, nativeMcp: true, reportsCost: false },
  config: { type: 'object', properties: {
    binary: { type: 'string', default: 'codex', title: 'Executable', description: 'Executable path, or codex.js on Windows.' },
    model: { type: 'string', title: 'Model', description: 'Leave empty for the CLI default. ChatGPT login supports a different model set from API access.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], title: 'Reasoning effort' },
    ignoreUserConfig: { type: 'boolean', default: false, title: 'Ignore user config', description: 'Skip host config.toml while reusing login credentials.' },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only', title: 'Sandbox', description: 'No interactive approvals; sandbox restrictions remain enforced.' },
  } },
};

export const CLAUDE_CODE_MANIFEST: HarnessManifest = {
  id: 'claude-code', name: 'Claude Code', version: '1.0.0', kind: 'native',
  capabilities: { streaming: true, resume: true, approvals: false, nativeMcp: true, reportsCost: true },
  config: { type: 'object', properties: {
    binary: { type: 'string', default: 'claude', title: 'Executable' },
    model: { type: 'string', title: 'Model' },
    maxTurns: { type: 'number', default: 20, title: 'Max turns' },
    permissionMode: { type: 'string', enum: ['plan', 'dontAsk', 'acceptEdits'], default: 'plan', title: 'Permission mode', description: 'Unanswered permissions are denied; no chat approval transport.' },
  } },
};

export const HTTP_MANIFEST: HarnessManifest = {
  id: 'http',
  name: 'HTTP harness',
  version: '1.0.0',
  kind: 'http',
  url: 'http://localhost:8787',
  capabilities: { streaming: true, resume: true, approvals: false, nativeMcp: false, reportsCost: false },
  config: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        title: 'Base URL',
        description: 'A service implementing the HTTP harness wire (see docs/harness-spec.md).',
      },
    },
  },
};

export const MOCK_MANIFEST: HarnessManifest = {
  id: 'mock',
  name: 'Mock (no model)',
  version: '1.0.0',
  kind: 'native',
  capabilities: { streaming: true, resume: true, approvals: false, nativeMcp: false, reportsCost: true },
  config: { type: 'object', properties: {} },
  metadata: { note: 'Deterministic; costs nothing. Good for testing the bridge itself.' },
};

export const HARNESS_CATALOG: CatalogEntry[] = [
  { manifest: CMD_MANIFEST, create: config => new CmdHarness(config as CmdConfig) },
  { manifest: CODEX_MANIFEST, create: config => new CodexHarness(config as CodexConfig) },
  { manifest: CLAUDE_CODE_MANIFEST, create: config => new ClaudeCodeHarness(config as ClaudeCodeConfig) },
  {
    manifest: HTTP_MANIFEST,
    create: config =>
      new HttpHarness({
        id: 'http',
        url: String(config.url ?? ''),
        config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'url')),
      }),
  },
  { manifest: MOCK_MANIFEST, create: () => new MockHarness() },
];

export function catalogEntry(id: string): CatalogEntry {
  const entry = HARNESS_CATALOG.find(candidate => candidate.manifest.id === id);
  if (!entry) {
    const known = HARNESS_CATALOG.map(candidate => candidate.manifest.id).join(', ');
    throw new Error(`unknown harness "${id}"; known: ${known}`);
  }
  return entry;
}

export function buildRunner(id: string, config: Record<string, unknown>): AgentRunner {
  return catalogEntry(id).create(config);
}

export interface ResolvedConfig {
  values: Record<string, unknown>;
  /** Keys the environment is pinning, so the dashboard can say so instead of looking broken. */
  pinned: string[];
}

/** Precedence: manifest defaults < dashboard-saved values < environment. */
export function resolveHarnessConfig(
  entry: CatalogEntry,
  saved: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const overrides = envOverrides(entry.manifest.id, entry.manifest.config, env);
  return {
    values: { ...schemaDefaults(entry.manifest.config), ...saved, ...overrides },
    pinned: Object.keys(overrides),
  };
}
