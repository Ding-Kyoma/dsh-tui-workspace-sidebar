import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_NEW,
  createJumpQueue,
  performJump,
  performNewSession,
  workspaceTargetFor,
} from '../jump.js';

test('jump queue: one slot, consumed once, expires', () => {
  let now = 1_000;
  const queue = createJumpQueue({ now: () => now, ttl: 100 });
  queue.request({ id: 'a', title: 'A', cwd: '/r', lang: 'zh' });
  queue.request({ id: 'b', title: 'B' });
  const target = queue.take();
  assert.equal(target.id, 'b');
  assert.equal(target.lang, undefined);
  assert.equal(queue.take(), undefined);

  queue.request({ id: 'c' });
  now += 101;
  assert.equal(queue.take(), undefined);
});

test('jump queue ignores empty targets and clear() drops the slot', () => {
  const queue = createJumpQueue();
  queue.request({ id: '' });
  assert.equal(queue.peek(), undefined);
  queue.request({ id: 'a' });
  queue.clear();
  assert.equal(queue.peek(), undefined);
});

test('performJump: success marks the row and closes', async () => {
  const calls = [];
  const result = await performJump({
    channel: { resumeTo: async id => { calls.push(id); return { ok: true }; } },
    target: { id: 's1', lang: 'en' },
    onSeen: id => calls.push(`seen:${id}`),
    onOpened: id => calls.push(`opened:${id}`),
    notify: text => calls.push(`notify:${text}`),
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['s1', 'seen:s1', 'opened:s1', 'close']);
});

test('performJump: failures notify, never mark seen, and close the scene', async () => {
  const cases = [
    { reason: 'occupied', pid: 99, expect: 'pid 99' },
    { reason: 'working', expect: 'in progress' },
    { reason: 'cancelled', expect: 'Cancelled' },
    { reason: 'failed', error: 'boom', expect: 'boom' },
  ];
  for (const spec of cases) {
    const calls = [];
    const result = await performJump({
      channel: { resumeTo: async () => ({ ok: false, ...spec }) },
      target: { id: 's1', lang: 'en' },
      onSeen: () => calls.push('seen'),
      onOpened: () => calls.push('opened'),
      notify: text => calls.push(text),
      close: () => calls.push('close'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, spec.reason);
    assert.ok(calls.some(text => text.includes(spec.expect)), `${spec.reason} should toast ${spec.expect}`);
    assert.ok(!calls.includes('seen'));
    assert.ok(!calls.includes('opened'), 'a failed jump must not release a parked question');
    assert.equal(calls.at(-1), 'close');
  }
});

test('performJump: unavailable is already toasted by the adapter, so it stays quiet', async () => {
  const calls = [];
  await performJump({
    channel: { resumeTo: async () => ({ ok: false, reason: 'unavailable' }) },
    target: { id: 's1', lang: 'en' },
    notify: text => calls.push(text),
    close: () => calls.push('close'),
  });
  assert.deepEqual(calls, ['close']);
});

test('performJump: a throwing resume and a missing channel both close', async () => {
  const thrown = [];
  const result = await performJump({
    channel: { resumeTo: async () => { throw new Error('nope'); } },
    target: { id: 's1', lang: 'en' },
    notify: text => thrown.push(text),
    close: () => thrown.push('close'),
  });
  assert.equal(result.ok, false);
  assert.ok(thrown.some(text => text.includes('nope')));

  const missing = [];
  const noChannel = await performJump({
    channel: undefined,
    target: { id: 's1', lang: 'en' },
    notify: text => missing.push(text),
    close: () => missing.push('close'),
  });
  assert.equal(noChannel.ok, false);
  assert.ok(missing.length >= 2);
  assert.equal(missing.at(-1), 'close');
});

test('jump queue: a new-session target carries its workspace and label', () => {
  const queue = createJumpQueue();
  queue.request({ kind: KIND_NEW, cwd: '/repo/app/', label: 'dsh-plugins', lang: 'zh' });
  const target = queue.take();
  assert.equal(target.kind, 'new');
  assert.equal(target.cwd, '/repo/app');
  assert.equal(target.label, 'dsh-plugins');
  assert.equal(target.lang, 'zh');

  queue.request({ kind: KIND_NEW, cwd: '   ' });
  assert.equal(queue.peek(), undefined);

  queue.request({ id: 's1' });
  assert.equal(queue.take().kind, 'jump');
});

test('jump queue: an unknown kind falls back to a row jump', () => {
  const queue = createJumpQueue();
  queue.request({ kind: 'bogus', id: 's1' });
  assert.equal(queue.take().kind, 'jump');
});

test('workspaceTargetFor: builds a local target with the cwd as display copy', () => {
  assert.deepEqual(workspaceTargetFor('/repo/app/', 'dsh-plugins'), {
    kind: 'local',
    cwd: '/repo/app',
    uri: 'file:///repo/app',
    label: 'dsh-plugins',
    description: '/repo/app',
    badge: '',
  });
  assert.equal(workspaceTargetFor('/repo/app').label, 'app');
  assert.equal(workspaceTargetFor(''), undefined);
});

test('performNewSession: idle in the same workspace is a plain /new', async () => {
  const calls = [];
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: false,
      newSession: async () => {
        calls.push('new');
        return true;
      },
      switchWorkspace: async () => {
        calls.push('switch');
        return true;
      },
      backgroundCurrent: async () => {
        calls.push('bg');
        return { ok: true, backgroundedSessionId: 'old' };
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/app/', label: 'dsh-plugins', lang: 'en' },
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['new', 'close']);
});

test('performNewSession: idle elsewhere hands the workspace off', async () => {
  const calls = [];
  let moved;
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: false,
      newSession: async () => {
        calls.push('new');
        return true;
      },
      switchWorkspace: async target => {
        moved = target;
        calls.push('switch');
        return true;
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/lib', label: 'lib', lang: 'en' },
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['switch', 'close']);
  assert.equal(moved.cwd, '/repo/lib');
  assert.equal(moved.kind, 'local');
  assert.equal(moved.label, 'lib');
});

test('performNewSession: a running turn is backgrounded and ends in the same cwd', async () => {
  const calls = [];
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: true,
      backgroundCurrent: async () => {
        calls.push('bg');
        return { ok: true, backgroundedSessionId: 'old' };
      },
      newSession: async () => {
        calls.push('new');
        return true;
      },
      switchWorkspace: async () => {
        calls.push('switch');
        return true;
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/app', lang: 'en' },
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['bg', 'close']);
});

test('performNewSession: a running turn is backgrounded before the handoff', async () => {
  const calls = [];
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: true,
      backgroundCurrent: async () => {
        calls.push('bg');
        return { ok: true, backgroundedSessionId: 'old' };
      },
      switchWorkspace: async target => {
        calls.push(`switch:${target.cwd}`);
        return true;
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/lib', lang: 'en' },
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['bg', 'switch:/repo/lib', 'close']);
});

test('performNewSession: a refused background parks the whole action', async () => {
  const calls = [];
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: true,
      backgroundCurrent: async () => ({ ok: false }),
      newSession: async () => {
        calls.push('new');
        return true;
      },
      switchWorkspace: async () => {
        calls.push('switch');
        return true;
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/lib', lang: 'en' },
    notify: text => calls.push(`notify:${text}`),
    close: () => calls.push('close'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'background-failed');
  assert.ok(calls.some(text => text.includes('cannot be backgrounded')));
  assert.deepEqual(calls.filter(text => text === 'switch' || text === 'new'), []);
  assert.equal(calls.at(-1), 'close');
});

test('performNewSession: a refused handoff closes quietly', async () => {
  const calls = [];
  const result = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: false,
      newSession: async () => {
        calls.push('new');
        return true;
      },
      switchWorkspace: async () => false,
    },
    target: { kind: KIND_NEW, cwd: '/repo/lib', lang: 'en' },
    notify: text => calls.push(`notify:${text}`),
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: false, reason: 'refused' });
  assert.deepEqual(calls, ['close']);
});

test('performNewSession: throwing host calls and a missing channel both toast and close', async () => {
  const thrown = [];
  const failed = await performNewSession({
    channel: {
      cwd: '/repo/app',
      working: false,
      switchWorkspace: async () => {
        throw new Error('nope');
      },
    },
    target: { kind: KIND_NEW, cwd: '/repo/lib', lang: 'en' },
    notify: text => thrown.push(text),
    close: () => thrown.push('close'),
  });
  assert.equal(failed.ok, false);
  assert.ok(thrown.some(text => text.includes('nope')));

  const missing = [];
  const noChannel = await performNewSession({
    channel: undefined,
    target: { kind: KIND_NEW, cwd: '/repo/lib', lang: 'en' },
    notify: text => missing.push(text),
    close: () => missing.push('close'),
  });
  assert.equal(noChannel.ok, false);
  assert.equal(noChannel.reason, 'unavailable');
  assert.ok(missing.some(text => text.includes('cannot create')));
  assert.equal(missing.at(-1), 'close');
});

test('performNewSession: a missing or non-new target closes silently', async () => {
  for (const target of [undefined, { id: 's1', lang: 'en' }, { kind: KIND_NEW, cwd: '  ', lang: 'en' }]) {
    const calls = [];
    const result = await performNewSession({
      channel: { cwd: '/repo/app' },
      target,
      notify: text => calls.push(text),
      close: () => calls.push('close'),
    });
    assert.deepEqual(result, { ok: false, reason: 'cancelled' });
    assert.deepEqual(calls, ['close']);
  }
});
