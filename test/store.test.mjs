import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, expandHome, normalizeState } from '../store.js';

async function tempFile(name = 'state.json') {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-sidebar-store-'));
  return join(dir, name);
}

test('expandHome: expands only a leading tilde', () => {
  assert.equal(expandHome('~'), process.env.HOME);
  assert.equal(expandHome('~/x/y'), join(process.env.HOME, 'x/y'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome(''), expandHome(undefined));
});

test('normalizeState: keeps valid rows and drops malformed ones', () => {
  const state = normalizeState({
    sessions: {
      ok: { cwd: '/r', title: 't', status: 'finished', failed: true, updatedAt: 10, finishedAt: 20, seenAt: 5 },
      running: { status: 'running' },
      badStatus: { status: 'weird' },
      badValue: null,
    },
  });
  assert.deepEqual(Object.keys(state.sessions), ['ok', 'running']);
  assert.equal(state.sessions.ok.failed, true);
  assert.equal(state.sessions.running.status, 'running');
});

test('store: missing file loads empty, save writes an atomic JSON file', async () => {
  const file = await tempFile();
  const store = createStore({ file, now: () => 1_000 });
  await store.ready();
  assert.deepEqual(store.snapshot().sessions, {});

  store.save({
    a: { cwd: '/r', title: 'A', status: 'finished', failed: false, updatedAt: 5, finishedAt: 6, seenAt: 0 },
  });
  await store.flush();

  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessions.a.title, 'A');
  assert.equal(parsed.sessions.a.finishedAt, 6);

  if (process.platform !== 'win32') {
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('store: save is debounced and flush always lands the latest state', async () => {
  const file = await tempFile();
  const store = createStore({ file });
  await store.ready();
  store.save({ a: { status: 'finished', finishedAt: 1, updatedAt: 1 } });
  store.save({ b: { status: 'finished', finishedAt: 2, updatedAt: 2 } });
  await store.flush();
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed.sessions), ['b']);
});

test('store: corrupt state is quarantined and replaced', async () => {
  const file = await tempFile();
  await writeFile(file, '{not json', 'utf8');
  const warnings = [];
  const store = createStore({ file, logger: { warn: message => warnings.push(message) }, now: () => 42 });
  await store.ready();
  assert.deepEqual(store.snapshot().sessions, {});
  assert.ok(warnings.some(message => message.includes('corrupt-42')));
  store.save({});
  await store.flush();
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(parsed.sessions, {});
});

test('store: saving copies the input and normalizes timestamps', async () => {
  const file = await tempFile();
  const store = createStore({ file });
  await store.ready();
  const source = { a: { cwd: '/r', title: 't', status: 'running', failed: true, updatedAt: '12', finishedAt: -1, seenAt: 'x' } };
  store.save(source);
  source.a.title = 'mutated';
  await store.flush();
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.sessions.a.title, 't');
  assert.equal(parsed.sessions.a.updatedAt, 12);
  assert.equal(parsed.sessions.a.finishedAt, 0);
  assert.equal(parsed.sessions.a.seenAt, 0);
});

test('store: save drops the in-memory waiting and plan fields', async () => {
  const file = await tempFile();
  const store = createStore({ file });
  await store.ready();
  store.save({
    a: { status: 'running', waiting: true, waitingAt: 10, plan: true, updatedAt: 10, finishedAt: 0, seenAt: 0 },
  });
  await store.flush();
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.sessions.a.waiting, undefined);
  assert.equal(parsed.sessions.a.waitingAt, undefined);
  assert.equal(parsed.sessions.a.plan, undefined);
});
