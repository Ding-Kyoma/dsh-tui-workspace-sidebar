import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttachedSessionId } from '../current.js';

async function tempFile(text) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-sidebar-current-'));
  const file = join(dir, 'servers.json');
  if (text !== undefined) await writeFile(file, text, 'utf8');
  return file;
}

test('reads the record for this pid only', async () => {
  const file = await tempFile(JSON.stringify([
    { pid: 1, sessionId: 'other', cwd: '/a', socketPath: '/s1', startedAt: 1 },
    { pid: 42, sessionId: 'mine', cwd: '/b', socketPath: '/s2', startedAt: 2 },
  ]));
  assert.equal(readAttachedSessionId({ file, pid: 42 }), 'mine');
  assert.equal(readAttachedSessionId({ file, pid: 7 }), undefined);
});

test('missing, malformed and empty discovery files are unknown', async () => {
  assert.equal(readAttachedSessionId({ file: await tempFile(undefined), pid: 1 }), undefined);
  assert.equal(readAttachedSessionId({ file: await tempFile('{oops'), pid: 1 }), undefined);
  assert.equal(readAttachedSessionId({ file: await tempFile('[]'), pid: 1 }), undefined);
  assert.equal(readAttachedSessionId({ file: await tempFile(JSON.stringify([{ pid: 1, sessionId: '' }])), pid: 1 }), undefined);
});
