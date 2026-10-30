import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RETENTION_HOURS, PANEL_ICON, PANEL_ORDER, PANEL_SUB_ID, apply, normalizeConfig } from '../index.js';
import { JUMP_SCENE_ID } from '../jump.js';

async function makeHarness({ withPanels = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-sidebar-apply-'));
  const stateFile = join(directory, 'state.json');
  const registered = [];
  const opened = [];
  const badges = [];
  const scenes = [];
  const commands = [];
  const shortcuts = [];
  const listeners = new Map();
  const services = {
    tuiPanels: withPanels
      ? {
        register(descriptor, identity) {
          registered.push({ descriptor, identity });
          return () => {};
        },
        list() {
          return [{ id: `session:act1:${PANEL_SUB_ID}`, title: '收件箱' }];
        },
        open(id) {
          opened.push(id);
          return true;
        },
        badge(id, badge) {
          badges.push({ id, badge });
          return true;
        },
      }
      : undefined,
    tuiScenes: {
      register(descriptor, identity) {
        scenes.push({ descriptor, identity });
        return () => {};
      },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
    tuiShortcuts: {
      register(combo, options, identity) {
        shortcuts.push({ combo, options, identity });
        return () => {};
      },
    },
  };

  function makeReady() {
    return {
      get(name, fallback) {
        return services[name] ?? fallback;
      },
      inject(_deps, callback) {
        callback(makeReady());
      },
      effect(fn) {
        const dispose = fn();
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
    };
  }

  const ctx = {
    logger: { warn() {} },
    get(name, fallback) {
      return services[name] ?? fallback;
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    inject(_deps, callback) {
      callback(makeReady());
    },
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  return { ctx, stateFile, registered, opened, badges, scenes, commands, shortcuts, listeners };
}

test('normalizeConfig: retentionHours defaults, accepts fractions, zero, and clamps', () => {
  assert.equal(DEFAULT_RETENTION_HOURS, 168);
  assert.equal(normalizeConfig({}).retentionHours, 168);
  assert.equal(normalizeConfig({ retentionHours: 0 }).retentionHours, 0);
  assert.equal(normalizeConfig({ retentionHours: 0.001 }).retentionHours, 0.001);
  assert.equal(normalizeConfig({ retentionHours: -1 }).retentionHours, 168);
  assert.equal(normalizeConfig({ retentionHours: 'abc' }).retentionHours, 168);
  assert.equal(normalizeConfig({ retentionHours: 10_000 }).retentionHours, 720);
});

test('normalizeConfig: relayQuestions defaults on and only an explicit false disables it', () => {
  assert.equal(normalizeConfig({}).relayQuestions, true);
  assert.equal(normalizeConfig({ relayQuestions: true }).relayQuestions, true);
  assert.equal(normalizeConfig({ relayQuestions: false }).relayQuestions, false);
});

test('apply registers a valid panel, the jump scene, /ws and the shortcut', async () => {
  const harness = await makeHarness();
  apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile, shortcut: 'alt+w' });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(harness.registered.length, 1);
  const { descriptor, identity } = harness.registered[0];
  assert.equal(descriptor.apiVersion, 1);
  assert.equal(descriptor.id, PANEL_SUB_ID);
  assert.equal(descriptor.title, '收件箱');
  assert.equal(descriptor.icon, PANEL_ICON);
  assert.equal(descriptor.icon.length, 1);
  assert.equal(descriptor.order, PANEL_ORDER);
  assert.equal(typeof descriptor.component, 'function');
  assert.ok(descriptor.minColumns === undefined || (descriptor.minColumns >= 12 && descriptor.minColumns <= 64));
  assert.ok(identity !== undefined);

  assert.deepEqual(harness.badges[0], { id: `session:act1:${PANEL_SUB_ID}`, badge: null });

  assert.equal(harness.scenes.length, 1);
  assert.equal(harness.scenes[0].descriptor.id, JUMP_SCENE_ID);
  assert.equal(typeof harness.scenes[0].descriptor.component, 'function');
  // host.openScene() attributes ownership to the calling activation context:
  // the panel and the scene must share one injected context or the scene
  // refuses to open ("belongs to another activation").
  assert.equal(identity, harness.scenes[0].identity);

  assert.equal(harness.commands.length, 1);
  assert.equal(harness.commands[0].name, 'ws');
  assert.deepEqual(harness.commands[0].handler({}), { kind: 'success' });
  assert.deepEqual(harness.opened, [`session:act1:${PANEL_SUB_ID}`]);

  assert.equal(harness.shortcuts.length, 1);
  assert.equal(harness.shortcuts[0].combo, 'alt+w');
  harness.shortcuts[0].options.handler();
  assert.deepEqual(harness.opened, [`session:act1:${PANEL_SUB_ID}`, `session:act1:${PANEL_SUB_ID}`]);
});

test('apply honors shortcut: off', async () => {
  const harness = await makeHarness();
  apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile, shortcut: 'off' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.shortcuts.length, 0);
});

test('apply degrades without tuiPanels and still does not throw', async () => {
  const harness = await makeHarness({ withPanels: false });
  assert.doesNotThrow(() => apply(harness.ctx, { lang: 'zh', stateFile: harness.stateFile }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.registered.length, 0);
  // The scene is independent of the panel and may still register; what must
  // not happen is a throw or a half-mounted panel.
  assert.ok(harness.scenes.length <= 1);
  assert.equal(harness.commands.length, 0);
});

test('apply tolerates a context without inject (small test hosts)', async () => {
  const harness = await makeHarness();
  const { ctx } = harness;
  delete ctx.inject;
  assert.doesNotThrow(() => apply(ctx, { lang: 'en', stateFile: harness.stateFile }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.registered.length, 1);
  assert.equal(harness.registered[0].descriptor.title, 'Inbox');
});

test('apply registers the question observer either way; relayQuestions only gates parking', async () => {
  const onHarness = await makeHarness();
  apply(onHarness.ctx, { lang: 'zh', stateFile: onHarness.stateFile, shortcut: 'off' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(onHarness.listeners.get('user-questions/request')?.length, 1);

  const offHarness = await makeHarness();
  apply(offHarness.ctx, {
    lang: 'zh',
    stateFile: offHarness.stateFile,
    shortcut: 'off',
    relayQuestions: false,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  // The waiting dot of an ask that is on screen right now is an observation,
  // not a relay: disabling the background fallback must not hide it. Only
  // parking is turned off.
  assert.equal(offHarness.listeners.get('user-questions/request')?.length, 1);
});

test('apply degrades when userQuestions is missing', async () => {
  const harness = await makeHarness();
  assert.doesNotThrow(() => apply(harness.ctx, {
    lang: 'en',
    stateFile: harness.stateFile,
    shortcut: 'off',
  }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.listeners.get('user-questions/request')?.length, 1);
});
