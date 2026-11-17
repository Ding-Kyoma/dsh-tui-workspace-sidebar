import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PANEL_SUB_ID, apply } from '../index.js';

/** The address an unadmitted (still anonymous) activation gets. */
const ANONYMOUS = (n = 1) => `session:act${n}:${PANEL_SUB_ID}`;
/** The address a host that admitted the manifest namespaces the panel with. */
const ADMITTED = `workspace-sidebar:${PANEL_SUB_ID}`;

/**
 * A host that hands out panel ids the way dsh-TUI does: the first registration
 * of an activation whose `dsh-plugin.json` is not admitted yet gets an
 * anonymous `session:actN:<sub>` id, and only a later registration sees the
 * admitted `<component>:<sub>` one.
 *
 * @param {{ admittedAfter?: number }} [options] registrations that stay anonymous before admission lands
 */
async function makeHarness({ admittedAfter = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-sidebar-id-'));
  const ids = [];
  const registrations = [];
  const badges = [];
  const warnings = [];

  const panels = {
    register(descriptor) {
      const attempt = registrations.length + 1;
      const id = attempt > admittedAfter ? ADMITTED : ANONYMOUS(attempt);
      registrations.push({ descriptor, id });
      ids.push(id);
      return () => {
        const index = ids.indexOf(id);
        if (index >= 0) ids.splice(index, 1);
      };
    },
    list() {
      return ids.map(id => ({ id, title: '收件箱' }));
    },
    open() {
      return true;
    },
    badge(id, badge) {
      badges.push({ id, badge });
      return true;
    },
  };

  const services = {
    tuiPanels: panels,
    tuiScenes: { register: () => () => {} },
    commands: { register: () => () => {} },
    tuiShortcuts: { register: () => () => {} },
  };

  const makeReady = () => ({
    get: (name, fallback) => services[name] ?? fallback,
    inject: (_deps, callback) => {
      callback(makeReady());
    },
    effect: fn => {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  });

  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
    },
    get: (name, fallback) => services[name] ?? fallback,
    on: () => () => {},
    inject: (_deps, callback) => {
      callback(makeReady());
    },
    effect: fn => {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  return {
    ctx,
    stateFile: join(directory, 'state.json'),
    ids,
    registrations,
    badges,
    warnings,
  };
}

test('a panel parked on an anonymous id is re-registered once the host admits it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = await makeHarness({ admittedAfter: 1 });
  apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile, shortcut: 'off' });

  assert.deepEqual(harness.ids, [ANONYMOUS()]);
  assert.deepEqual(harness.badges.at(-1), { id: ANONYMOUS(), badge: null });

  t.mock.timers.tick(1000);

  // One replacement: the admitted address replaces the anonymous one, so the
  // registry never keeps two inbox panels.
  assert.equal(harness.registrations.length, 2);
  assert.deepEqual(harness.ids, [ADMITTED]);
  assert.deepEqual(harness.badges.at(-1), { id: ADMITTED, badge: null });

  // Later rungs of the ladder must not churn a panel that already settled.
  t.mock.timers.tick(2000);
  t.mock.timers.tick(4000);
  assert.equal(harness.registrations.length, 2);
  assert.deepEqual(harness.ids, [ADMITTED]);
  assert.deepEqual(harness.warnings, []);
});

test('an already admitted id is never re-registered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = await makeHarness({ admittedAfter: 0 });
  apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile, shortcut: 'off' });

  assert.deepEqual(harness.ids, [ADMITTED]);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(2000);
  t.mock.timers.tick(4000);
  t.mock.timers.tick(8000);

  assert.equal(harness.registrations.length, 1);
  assert.deepEqual(harness.ids, [ADMITTED]);
});

test('an activation that is never admitted keeps exactly one anonymous panel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = await makeHarness({ admittedAfter: Number.POSITIVE_INFINITY });
  apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile, shortcut: 'off' });

  assert.deepEqual(harness.ids, [ANONYMOUS()]);

  // The whole ladder: 1s, 2s, 4s, 8s, then it stops trying.
  t.mock.timers.tick(1000);
  t.mock.timers.tick(2000);
  t.mock.timers.tick(4000);
  t.mock.timers.tick(8000);
  t.mock.timers.tick(60_000);

  assert.equal(harness.registrations.length, 5);
  assert.equal(harness.ids.length, 1);
  assert.ok(harness.ids[0].startsWith('session:'));
  assert.deepEqual(harness.warnings, []);
});
