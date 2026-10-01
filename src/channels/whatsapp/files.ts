import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpenWaMessage } from './types.ts';

export const FILE_LIMIT = 10 * 1024 * 1024;

function within(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('File must be inside the agent workspace.');
}

export async function outgoingFile(workspace: string, path: string, mime?: string) {
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, path));
  within(root, target);
  if (relative(root, target).split(sep).some(part => part.startsWith('.'))) throw new Error('Hidden files cannot be sent.');
  const handle = await open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error('Only files up to 10 MiB can be sent.');
    const data = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > FILE_LIMIT || bytesRead > stat.size) throw new Error('File changed while reading; try again.');
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' };
    return { filename: basename(target), mimetype: mime ?? types[extname(target).toLowerCase()] ?? 'application/octet-stream', base64: data.subarray(0, bytesRead).toString('base64') };
  } finally { await handle.close(); }
}

export async function incomingFile(workspace: string, media: NonNullable<OpenWaMessage['media']>): Promise<string> {
  if (media.omitted || !media.data) throw new Error('OpenWA omitted the attachment; resend a smaller file with @me in its caption.');
  if (media.data.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(media.data)) throw new Error('Invalid attachment or file exceeds 10 MiB.');
  const data = Buffer.from(media.data, 'base64');
  if (data.length > FILE_LIMIT) throw new Error('Attachment exceeds 10 MiB.');
  const root = await realpath(workspace);
  const parent = join(root, 'attachments');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  within(root, await realpath(parent));
  const dir = join(parent, randomUUID());
  await mkdir(dir, { mode: 0o700 });
  const filename = basename(media.filename ?? 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'attachment';
  const path = join(dir, filename);
  await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  return path;
}
