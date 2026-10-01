import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('imports selected ChatGPT branch and Claude text while excluding other projects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-import-'));
  try {
    const source = join(dir, 'export.json'), output = join(dir, 'context');
    await writeFile(source, JSON.stringify([
      { title: 'agent-bridge ChatGPT', current_node: 'answer', mapping: {
        question: { parent: null, message: { author: { role: 'user' }, content: { parts: ['question'] } } },
        answer: { parent: 'question', message: { author: { role: 'assistant' }, content: { parts: ['selected answer'] } } },
        alternative: { parent: 'question', message: { author: { role: 'assistant' }, content: { parts: ['wrong branch'] } } },
      } },
      { name: 'agent-bridge Claude', chat_messages: [{ sender: 'human', text: 'password=example-secret' }, { sender: 'assistant', content: [{ type: 'text', text: 'Claude answer' }] }] },
      { name: 'unrelated', messages: [{ role: 'user', content: 'private unrelated data' }] },
    ]));
    execFileSync(process.execPath, [resolve('scripts/import-context.mjs'), '--source', source, '--output', output, '--match', 'agent-bridge']);
    const files = await readdir(output);
    assert.equal(files.length, 2);
    const content = (await Promise.all(files.map(file => readFile(join(output, file), 'utf8')))).join('\n');
    assert.ok(content.includes('selected answer') && content.includes('Claude answer'));
    assert.ok(!content.includes('wrong branch') && !content.includes('example-secret') && !content.includes('private unrelated'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
