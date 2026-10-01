import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function cliOutput(binary: string, args: string[]): Promise<string> {
  const script = /\.(mjs|cjs|js)$/i.test(binary);
  const result = await promisify(execFile)(script ? process.execPath : binary, script ? [binary, ...args] : args,
    { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

export function commandModels(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).flatMap(line => {
    const id = /^\s*([\w.-]+\/[\w./-]+)\s{2,}\S/.exec(line)?.[1];
    return id ? [id] : [];
  }))];
}

export async function codexModels(): Promise<string[]> {
  const data = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
  return (data.models ?? []).filter((model: any) => model.visibility === 'list' && typeof model.slug === 'string').map((model: any) => model.slug);
}

export function claudeModels(help: string): string[] {
  const start = help.indexOf('--model');
  const line = start < 0 ? '' : help.slice(start).split(/\n\s+-{1,2}[a-z]/)[0]!;
  return [...new Set([...line.matchAll(/'([a-z][a-z-]*)'/g)].map(match => match[1]!).filter(id => !id.startsWith('claude-')))];
}
