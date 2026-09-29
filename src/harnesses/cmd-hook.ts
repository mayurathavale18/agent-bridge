import { existsSync } from 'node:fs';
import { mkdir, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the bundled approval hook script. */
export function bundledApprovalHookPath(): string {
  return fileURLToPath(new URL('./hooks/cmd-approval-hook.mjs', import.meta.url));
}

export interface InstallApprovalHookOptions {
  /** Tool matcher; Command Code tests it against SHELL / READ / WRITE / EDIT. */
  matcher?: string;
  /** Hook timeout in seconds (Command Code caps this at 600). */
  timeoutSeconds?: number;
}

/**
 * Install a `PreToolUse` approval hook into the workspace's `.commandcode/settings.json`
 * and return a function that restores the file to its exact previous bytes.
 *
 * Deliberately non-destructive: an existing settings.json is parsed and merged (other keys
 * and other hooks are preserved), and the restore removes the file only when the bridge
 * created it. Command Code reads hooks from this path, which is the one setting that has no
 * command-line override — so a temporary, restored edit is the only way to gate tools.
 */
export async function installApprovalHook(
  workspace: string,
  opts: InstallApprovalHookOptions = {},
): Promise<() => Promise<void>> {
  const dir = join(workspace, '.commandcode');
  const file = join(dir, 'settings.json');
  const existed = existsSync(file);
  const createdDir = !existsSync(dir);
  const previous = existed ? await readFile(file, 'utf8') : undefined;

  let settings: Record<string, unknown> = {};
  if (previous) {
    try {
      const parsed = JSON.parse(previous) as unknown;
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
    } catch {
      // Unparseable settings are left untouched on restore; start from an empty object here.
      settings = {};
    }
  }

  const hooks =
    settings.hooks && typeof settings.hooks === 'object' ? (settings.hooks as Record<string, unknown>) : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : [];

  const command = `node "${bundledApprovalHookPath()}"`;
  const alreadyInstalled = preToolUse.some(entry => JSON.stringify(entry).includes('cmd-approval-hook'));
  if (!alreadyInstalled) {
    preToolUse.push({
      matcher: opts.matcher ?? 'shell|write|edit',
      hooks: [{ type: 'command', command, timeout: opts.timeoutSeconds ?? 600 }],
    });
  }

  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  return async () => {
    if (previous !== undefined) {
      await writeFile(file, previous, 'utf8');
      return;
    }
    await rm(file, { force: true });
    if (createdDir) await rmdir(dir).catch(() => undefined);
  };
}
