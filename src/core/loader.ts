import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateManifest } from './manifest.ts';
import { HttpHarness } from '../harnesses/http.ts';
import type { AgentRunner } from './runner.ts';

/**
 * Load a harness from a `harness.json` manifest.
 *
 * `kind: "http"` wraps the manifest's URL in an HttpHarness. `kind: "native"` dynamically
 * imports the manifest's `entry` module, resolving it relative to the manifest file, and
 * calls its exported `createRunner(config)` — the extension point for in-process plugins.
 */
export async function loadHarnessManifest(path: string, config: Record<string, unknown> = {}): Promise<AgentRunner> {
  const manifest = validateManifest(JSON.parse(await readFile(path, 'utf8')));

  if (manifest.kind === 'http') {
    return new HttpHarness({
      id: manifest.id,
      url: manifest.url as string,
      config,
      capabilities: manifest.capabilities,
    });
  }

  const entryUrl = new URL(manifest.entry as string, pathToFileURL(path)).href;
  const mod = (await import(entryUrl)) as { createRunner?: (config: Record<string, unknown>) => AgentRunner };
  if (typeof mod.createRunner !== 'function') {
    throw new Error(`manifest.entry must export createRunner(config): ${manifest.entry}`);
  }
  return mod.createRunner(config);
}
