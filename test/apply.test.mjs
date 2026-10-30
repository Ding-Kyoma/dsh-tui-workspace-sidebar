import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PANEL_ICON, PANEL_ORDER, PANEL_SUB_ID, apply } from '../index.js';
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
    on() {
      return () => {};
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

  return { ctx, stateFile, registered, opened, badges, scenes, commands, shortcuts };
}

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
  assert.equal(harness.scenes.length, 0);
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
