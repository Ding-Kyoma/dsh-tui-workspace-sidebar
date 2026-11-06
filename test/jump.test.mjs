import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  KIND_NEW,
  SCENE_MOUNT_GRACE_MS,
  createJumpQueue,
  createJumpScene,
  createSceneGuard,
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

test('performJump: success marks the row, closes, then releases the question', async () => {
  const calls = [];
  const result = await performJump({
    channel: { resumeTo: async id => { calls.push(id); return { ok: true }; } },
    target: { id: 's1', lang: 'en' },
    onSeen: id => calls.push(`seen:${id}`),
    onOpened: id => calls.push(`opened:${id}`),
    notify: text => calls.push(`notify:${text}`),
    close: () => calls.push('close'),
    // Run the deferred release inline: the ORDER is what matters here, and the
    // scene must already be closed when the question is re-dispatched.
    defer: callback => callback(),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['s1', 'seen:s1', 'close', 'opened:s1']);
});

test('performJump: the default release runs one task later, after the close', async () => {
  const calls = [];
  const result = await performJump({
    channel: { resumeTo: async () => ({ ok: true }) },
    target: { id: 's1' },
    onOpened: id => calls.push(`opened:${id}`),
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  // Nothing is released inside the jump itself any more.
  assert.deepEqual(calls, ['close']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['close', 'opened:s1']);
});

test('performJump: a throwing release never reopens or fails the jump', async () => {
  const calls = [];
  const result = await performJump({
    channel: { resumeTo: async () => ({ ok: true }) },
    target: { id: 's1' },
    onOpened: () => { throw new Error('relay exploded'); },
    close: () => calls.push('close'),
    defer: callback => callback(),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['close']);
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
    uri: pathToFileURL('/repo/app').href,
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

test('the jump scene consumes its one-shot target once across repeated renders', () => {
  // React StrictMode renders a component twice. A state initializer would call
  // queue.take() twice and the second take would return undefined; the ref guard
  // must keep the first target for every render of the same scene.
  let takes = 0;
  const queue = {
    take() {
      takes += 1;
      return { id: 's1', title: 'One' };
    },
  };
  const Scene = createJumpScene({
    queue,
    tracker: { markSeen() {} },
    config: { lang: 'en' },
  });

  const hooks = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef() {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) hooks[index] = { current: undefined };
      return hooks[index];
    },
    useEffect() {
      cursor += 1;
    },
  };
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useInput() {},
    useTerminalSize: () => ({ columns: 80, rows: 24 }),
    useAnimationFrame: () => [0, 0],
  };
  const props = {
    React,
    ui,
    channel: { notify() {} },
    close() {},
  };

  Scene(props);
  cursor = 0;
  Scene(props);

  assert.equal(takes, 1);
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

/** A deterministic timer double: `fire()` runs every live handle once. */
function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, ms) {
      const handle = {
        callback,
        ms,
        cancelled: false,
        fired: false,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
          return handle;
        },
      };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cancelled = true;
    },
    fire() {
      for (const timer of timers) {
        if (timer.cancelled || timer.fired) continue;
        timer.fired = true;
        timer.callback();
      }
    },
  };
}

test('scene guard: a scene that mounts stands the guard down', () => {
  const clock = fakeClock();
  const closed = [];
  const notices = [];
  const guard = createSceneGuard({ close: () => closed.push('close'), ...clock });
  guard.arm(() => notices.push('notice'));
  assert.equal(guard.pending, true);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, SCENE_MOUNT_GRACE_MS);
  guard.settle();
  assert.equal(guard.pending, false);
  clock.fire();
  assert.deepEqual(closed, []);
  assert.deepEqual(notices, []);
});

test('scene guard: a scene the host never mounts is closed once and reported', () => {
  const clock = fakeClock();
  const closed = [];
  const notices = [];
  const guard = createSceneGuard({ close: () => closed.push('close'), ...clock });
  guard.arm(() => notices.push('notice'));
  clock.fire();
  assert.deepEqual(closed, ['close']);
  assert.deepEqual(notices, ['notice']);
  assert.equal(guard.pending, false);
  clock.fire();
  assert.deepEqual(closed, ['close'], 'the stranded action runs once');
  assert.deepEqual(notices, ['notice']);
});

test('scene guard: re-arming keeps only the latest click', () => {
  const clock = fakeClock();
  const closed = [];
  const notices = [];
  const guard = createSceneGuard({ close: () => closed.push('close'), ...clock });
  guard.arm(() => notices.push('first'));
  guard.arm(() => notices.push('second'));
  assert.equal(clock.timers.length, 2);
  assert.equal(clock.timers[0].cancelled, true);
  clock.fire();
  assert.deepEqual(closed, ['close']);
  assert.deepEqual(notices, ['second']);
});

test('scene guard: dispose drops the timer without closing anything', () => {
  const clock = fakeClock();
  const closed = [];
  const notices = [];
  const guard = createSceneGuard({ close: () => closed.push('close'), ...clock });
  guard.arm(() => notices.push('notice'));
  guard.dispose();
  clock.fire();
  assert.deepEqual(closed, []);
  assert.deepEqual(notices, []);
  assert.equal(guard.pending, false);
});

test('scene guard: a refused close still reports and logs the failure', () => {
  const clock = fakeClock();
  const warnings = [];
  const notices = [];
  const guard = createSceneGuard({
    close: () => {
      throw new Error('belongs to another activation');
    },
    logger: { warn: (message, error) => warnings.push([message, error?.message]) },
    ...clock,
  });
  guard.arm(() => notices.push('notice'));
  clock.fire();
  assert.deepEqual(notices, ['notice']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /stranded/);
  assert.equal(warnings[0][1], 'belongs to another activation');
});

test('scene guard: the grace timer is unref\'d so it cannot hold the process open', () => {
  const clock = fakeClock();
  const guard = createSceneGuard({ close: () => {}, ...clock });
  guard.arm();
  assert.equal(clock.timers[0].unrefCalled, true);
  guard.settle();
});
