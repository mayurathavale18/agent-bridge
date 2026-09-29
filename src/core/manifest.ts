import type { HarnessCapabilities } from './runner.ts';

/** A JSON Schema object. Loose on purpose — the dashboard renders whatever schema a plugin ships. */
export type JsonSchema = Record<string, unknown>;

/**
 * A harness plugin manifest. Either an in-process native class (`kind: "native"`, `entry`
 * points at a module exporting `createRunner`) or an out-of-process service (`kind: "http"`,
 * `url` is the base URL the bridge POSTs runs to).
 *
 * `config` is the json-schema the config UI renders; the same keys resolve from env in
 * headless mode (see docs/harness-spec.md, "Configuration").
 */
export interface HarnessManifest {
  id: string;
  name: string;
  version: string;
  kind: 'native' | 'http';
  /** For kind "native": module path (relative to the manifest) exporting `createRunner(config)`. */
  entry?: string;
  /** For kind "http": base URL implementing the HTTP harness wire. */
  url?: string;
  capabilities: HarnessCapabilities;
  config?: JsonSchema;
  /** Free-form author/marketplace metadata the dashboard may display. */
  metadata?: Record<string, string>;
}

const CAPABILITY_KEYS: ReadonlyArray<keyof HarnessCapabilities> = [
  'streaming',
  'resume',
  'approvals',
  'nativeMcp',
  'reportsCost',
];

/**
 * Validate an unknown value as a HarnessManifest. Throws with a specific message on the
 * first problem — a manifest typo should fail loudly at load, not silently disable a plugin.
 */
export function validateManifest(value: unknown): HarnessManifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest must be an object');
  const m = value as Record<string, unknown>;

  for (const key of ['id', 'name', 'version'] as const) {
    if (typeof m[key] !== 'string' || m[key] === '') throw new Error(`manifest.${key} must be a non-empty string`);
  }
  if (m.kind !== 'native' && m.kind !== 'http') throw new Error('manifest.kind must be "native" or "http"');
  if (m.kind === 'native' && typeof m.entry !== 'string') throw new Error('manifest.entry is required when kind is "native"');
  if (m.kind === 'http' && typeof m.url !== 'string') throw new Error('manifest.url is required when kind is "http"');

  if (typeof m.capabilities !== 'object' || m.capabilities === null) {
    throw new Error('manifest.capabilities must be an object');
  }
  const caps = m.capabilities as Record<string, unknown>;
  for (const key of CAPABILITY_KEYS) {
    if (typeof caps[key] !== 'boolean') throw new Error(`manifest.capabilities.${key} must be a boolean`);
  }

  return m as unknown as HarnessManifest;
}
