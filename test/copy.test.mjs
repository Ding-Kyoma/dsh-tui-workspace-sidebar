import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COPY_TOAST_MS,
  HOST_CLIPBOARD_SUBPATH,
  HOST_PACKAGE,
  clipboardSequence,
  createClipboard,
  hostClipboardCandidates,
  loadHostClipboard,
} from '../copy.js';

/** A stdout sink that records what the writer emitted. */
function makeStdout() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
  };
}

const HOST_PATH = join('node_modules', ...HOST_PACKAGE.split('/'), HOST_CLIPBOARD_SUBPATH);

test('copy: the toast promise is three seconds', () => {
  assert.equal(COPY_TOAST_MS, 3000);
});

test('copy: the host module is located through the running profile first', () => {
  const candidates = hostClipboardCandidates({ DSH_PROFILE_DIR: '/profiles/dsh-tui' });
  assert.equal(candidates[0], join('/profiles/dsh-tui', HOST_PATH));
  assert.ok(candidates.every(path => path.endsWith(HOST_CLIPBOARD_SUBPATH)));
});

test('copy: DSH_HOME plus DSH_PROFILE is the second guess', () => {
  const candidates = hostClipboardCandidates({
    DSH_PROFILE_DIR: '/profiles/dsh-tui',
    DSH_HOME: '/home/person/.dsh',
    DSH_PROFILE: 'dsh-tui',
  });
  assert.equal(candidates[0], join('/profiles/dsh-tui', HOST_PATH));
  assert.equal(candidates[1], join('/home/person/.dsh', 'profiles', 'dsh-tui', HOST_PATH));
});

test('copy: a home without DSH_PROFILE falls back to the default profile name', () => {
  const candidates = hostClipboardCandidates({ DSH_HOME: '/home/person/.dsh' });
  assert.equal(candidates[0], join('/home/person/.dsh', 'profiles', 'dsh-tui', HOST_PATH));
});

test('copy: candidates are de-duplicated', () => {
  const profile = '/profiles/dsh-tui';
  const candidates = hostClipboardCandidates({
    DSH_PROFILE_DIR: profile,
    DSH_HOME: '/profiles',
    DSH_PROFILE: 'dsh-tui',
  });
  // `/profiles/profiles/dsh-tui` is a different path, so only the bare
  // resolution can collide; assert the list itself has no duplicates.
  assert.equal(new Set(candidates).size, candidates.length);
});

test('copy: the fallback sequence is OSC 52 with a UTF-8 base64 payload', () => {
  assert.equal(clipboardSequence('abc'), '\x1b]52;c;YWJj\x07');
  assert.equal(clipboardSequence('中文'), `\x1b]52;c;${Buffer.from('中文', 'utf8').toString('base64')}\x07`);
  assert.equal(clipboardSequence(undefined), '\x1b]52;c;\x07');
});

test('copy: the host writer is used first and its sequence is emitted', async () => {
  const stdout = makeStdout();
  const calls = [];
  const clipboard = createClipboard({
    env: {},
    loadHost: async () => ({
      async setClipboard(text) {
        calls.push(text);
        return 'OSC52';
      },
    }),
    run: async () => assert.fail('the native fallback must not run'),
    stdout,
  });

  const result = await clipboard.copy('/repo/app');
  assert.deepEqual(result, { ok: true, via: 'host' });
  assert.deepEqual(calls, ['/repo/app']);
  assert.deepEqual(stdout.chunks, ['OSC52']);
});

test('copy: the host module is loaded once per activation', async () => {
  let loads = 0;
  const clipboard = createClipboard({
    env: {},
    loadHost: async () => {
      loads += 1;
      return { setClipboard: async () => 'SEQ' };
    },
    run: async () => false,
    stdout: makeStdout(),
  });
  await clipboard.copy('/a');
  await clipboard.copy('/b');
  assert.equal(loads, 1);
});

test('copy: a host module with no writer falls through to the fallback', async () => {
  const stdout = makeStdout();
  const commands = [];
  const clipboard = createClipboard({
    env: {},
    platform: 'darwin',
    loadHost: async () => ({}),
    run: async (file, args, text) => {
      commands.push([file, [...args], text]);
      return true;
    },
    stdout,
  });

  const result = await clipboard.copy('/repo/app');
  assert.deepEqual(result, { ok: true, via: 'native' });
  assert.deepEqual(commands, [['pbcopy', [], '/repo/app']]);
  assert.deepEqual(stdout.chunks, [clipboardSequence('/repo/app')], 'OSC 52 is still emitted');
});

test('copy: a throwing host writer falls back instead of failing the click', async () => {
  const clipboard = createClipboard({
    env: {},
    platform: 'darwin',
    loadHost: async () => ({
      async setClipboard() {
        throw new Error('host module moved');
      },
    }),
    run: async () => true,
    stdout: makeStdout(),
  });
  assert.deepEqual(await clipboard.copy('/repo/app'), { ok: true, via: 'native' });
});

test('copy: no native tool leaves the OSC 52 write as the success', async () => {
  const stdout = makeStdout();
  const clipboard = createClipboard({
    env: {},
    platform: 'linux',
    loadHost: async () => undefined,
    run: async () => false,
    stdout,
  });
  const result = await clipboard.copy('/repo/app');
  assert.equal(result.ok, true);
  assert.equal(result.via, 'osc52');
  assert.deepEqual(stdout.chunks, [clipboardSequence('/repo/app')]);
});

test('copy: linux probes wl-copy, then xclip, then xsel', async () => {
  const seen = [];
  const clipboard = createClipboard({
    env: {},
    platform: 'linux',
    loadHost: async () => undefined,
    run: async (file, args) => {
      seen.push([file, [...args]]);
      return file === 'xclip';
    },
    stdout: makeStdout(),
  });
  const result = await clipboard.copy('/repo/app');
  assert.deepEqual(result, { ok: true, via: 'native' });
  assert.deepEqual(seen, [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
  ]);
});

test('copy: windows uses clip and never pbcopy', async () => {
  const seen = [];
  const clipboard = createClipboard({
    env: {},
    platform: 'win32',
    loadHost: async () => undefined,
    run: async (file, args) => {
      seen.push([file, [...args]]);
      return true;
    },
    stdout: makeStdout(),
  });
  assert.equal((await clipboard.copy('C:/repo/app')).ok, true);
  assert.deepEqual(seen, [['clip', []]]);
});

test('copy: over SSH the native clipboard is never touched', async () => {
  const commands = [];
  const stdout = makeStdout();
  const clipboard = createClipboard({
    env: { SSH_CONNECTION: '10.0.0.1 55123 10.0.0.2 22' },
    platform: 'darwin',
    loadHost: async () => undefined,
    run: async (file, args, text) => {
      commands.push([file, [...args], text]);
      return true;
    },
    stdout,
  });
  const result = await clipboard.copy('/repo/app');
  assert.deepEqual(result, { ok: true, via: 'osc52' });
  assert.deepEqual(commands, [], 'a remote machine clipboard is not where the person pastes');
  assert.deepEqual(stdout.chunks, [clipboardSequence('/repo/app')]);
});

test('copy: an empty path is refused before any helper runs', async () => {
  const clipboard = createClipboard({
    env: {},
    loadHost: async () => assert.fail('nothing to copy'),
    run: async () => assert.fail('nothing to copy'),
    stdout: makeStdout(),
  });
  assert.deepEqual(await clipboard.copy(''), { ok: false, via: 'none', reason: 'empty' });
});

test('copy: a broken stdout still reports failure instead of throwing', async () => {
  const clipboard = createClipboard({
    env: {},
    platform: 'linux',
    loadHost: async () => undefined,
    run: async () => false,
    stdout: {
      write() {
        throw new Error('stdout closed');
      },
    },
  });
  assert.deepEqual(await clipboard.copy('/repo/app'), { ok: false, via: 'none', reason: 'unavailable' });
});

test('copy: loadHostClipboard imports the module at the discovered path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-sidebar-copy-'));
  try {
    const file = join(root, HOST_PATH);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'export async function setClipboard(text) { return `FAKE:${text}`; }\n', 'utf8');
    const module = await loadHostClipboard({ DSH_PROFILE_DIR: root });
    assert.equal(typeof module?.setClipboard, 'function');
    assert.equal(await module.setClipboard('x'), 'FAKE:x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copy: loadHostClipboard answers undefined when the file is gone', async () => {
  const module = await loadHostClipboard({ DSH_PROFILE_DIR: '/definitely/missing' }, async () => assert.fail('no import'), () => false);
  assert.equal(module, undefined);
});
