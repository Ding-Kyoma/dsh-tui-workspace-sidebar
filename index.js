/**
 * Workspace sidebar — a lightweight right-side panel listing the conversations
 * that are running now or finished but not yet read, grouped by project.
 *
 * Design notes that explain the shape of this file:
 *
 * - A plugin panel gets no channel, so it cannot call `channel.resumeTo`
 *   directly. Clicking a row therefore drops a one-shot target in a queue and
 *   opens a registered scene, whose props *do* carry the live channel; the
 *   scene performs the resume and closes. That transition card is the only
 *   public-API path to a session switch in dsh-tui 0.17.0.
 * - Everything is feature-detected and fail-open: a missing `agents`,
 *   `tuiPanels`, `tuiScenes`, `tuiWorkspaces`, `tuiPluginHost` or `commands`
 *   degrades that capability instead of failing the activation.
 * - The panel is registered without a `dsh-plugin.json` manifest, so its final
 *   id is temporary (`session:actN:inbox`) and cannot be persisted. The id is
 *   re-resolved from `panels.list()` on every activation.
 */

import { readAttachedSessionId } from './current.js';
import { JUMP_SCENE_ID, createJumpQueue, createJumpScene } from './jump.js';
import { createPanel } from './panel.js';
import { DEFAULT_STATE_FILE, createStore } from './store.js';
import { createTracker } from './tracker.js';
import { messagesFor, resolveLang } from './strings.js';

export const name = 'workspace-sidebar';
export const PANEL_SUB_ID = 'inbox';
export const PANEL_ICON = '▣';
export const PANEL_ORDER = 10;
export const DEFAULT_SHORTCUT = 'alt+w';

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * @param {{lang?: unknown, stateFile?: unknown, shortcut?: unknown}} [config]
 */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const lang = source.lang === 'zh' || source.lang === 'en' ? source.lang : 'auto';
  const stateFile = typeof source.stateFile === 'string' && source.stateFile.trim() !== ''
    ? source.stateFile.trim()
    : DEFAULT_STATE_FILE;
  const shortcut = typeof source.shortcut === 'string' ? source.shortcut.trim() : DEFAULT_SHORTCUT;
  return { lang, stateFile, shortcut };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{lang?: 'zh' | 'en' | 'auto', stateFile?: string, shortcut?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger;
  const warn = (message, error) => {
    try {
      const tail = error === undefined ? '' : `: ${messageOf(error)}`;
      logger?.warn?.(`workspace-sidebar: ${message}${tail}`);
    } catch {
      // Logging must never break activation.
    }
  };

  try {
    const settings = normalizeConfig(config);
    const copy = messagesFor(resolveLang(settings.lang));
    const store = createStore({ file: settings.stateFile, logger });
    const tracker = createTracker({
      ctx,
      store,
      logger,
      probe: () => readAttachedSessionId(),
    });
    const queue = createJumpQueue();
    let sceneReady = false;
    let panelsService;
    let panelId = '';
    const jump = { sceneId: JUMP_SCENE_ID, queue, sceneReady: () => sceneReady };

    tracker.attach();
    void tracker.load();

    if (typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => () => {
          tracker.dispose();
          void store.close().catch(() => {});
        }, 'workspace-sidebar tracker');
      } catch (error) {
        warn('registering the lifecycle effect failed', error);
      }
    }

    function openPanel() {
      if (panelId === '' || !panelsService || typeof panelsService.open !== 'function') return false;
      try {
        return panelsService.open(panelId) === true;
      } catch (error) {
        warn('opening the panel failed', error);
        return false;
      }
    }

    /**
     * @param {any} panels
     * @returns {string} the host-assigned id, or '' when it cannot be resolved
     */
    function resolvePanelId(panels) {
      try {
        const list = panels.list();
        if (!Array.isArray(list)) return '';
        const suffix = `:${PANEL_SUB_ID}`;
        const found = list.find(entry => entry && typeof entry.id === 'string' && entry.id.endsWith(suffix));
        return found ? found.id : '';
      } catch (error) {
        warn('panels.list() failed', error);
        return '';
      }
    }

    /**
     * @param {any} ready
     */
    function mountScene(ready) {
      let scenes;
      try {
        scenes = ready.get('tuiScenes', false);
      } catch (error) {
        warn('tuiScenes is unavailable', error);
        return;
      }
      if (!scenes || typeof scenes.register !== 'function') {
        warn('tuiScenes is unavailable; click-to-jump is disabled');
        return;
      }
      const Scene = createJumpScene({ queue, tracker, config: settings });
      let dispose;
      try {
        dispose = scenes.register({ id: JUMP_SCENE_ID, title: copy.sceneTitle, component: Scene }, ready);
      } catch (error) {
        warn('the jump scene was rejected', error);
        return;
      }
      if (typeof dispose !== 'function') {
        warn('the jump scene was rejected (duplicate id?)');
        return;
      }
      sceneReady = true;
      if (typeof ready.effect === 'function') {
        try {
          ready.effect(() => () => {
            sceneReady = false;
            try {
              dispose();
            } catch {
              // Disposal is best-effort.
            }
          }, 'workspace-sidebar jump scene');
        } catch (error) {
          warn('registering the scene lifecycle effect failed', error);
        }
      }
    }

    /**
     * @param {any} ready
     */
    function mountCommand(ready) {
      const definition = {
        name: 'ws',
        description: copy.commandDescription,
        handler: () => {
          if (!openPanel()) return { kind: 'error', text: copy.panelUnavailable };
          return { kind: 'success' };
        },
      };
      let host;
      try {
        host = ready.get('tuiPluginHost', false);
      } catch {
        host = undefined;
      }
      if (host && typeof host.registerCommand === 'function') {
        try {
          const dispose = host.registerCommand(ready, definition);
          if (typeof dispose === 'function' && typeof ready.effect === 'function') {
            ready.effect(() => dispose, 'workspace-sidebar command');
          }
          return;
        } catch (error) {
          // A manifest-less local plugin has no verified Component identity, so
          // the mediated surface refuses it. The commands service is a public
          // Cordis service and still accepts an unattributed global definition
          // (the documented C-070 boundary).
          warn('mediated command registration was refused; falling back', error);
        }
      }
      let commands;
      try {
        commands = ready.get('commands', false);
      } catch {
        commands = undefined;
      }
      if (!commands || typeof commands.register !== 'function') {
        warn('neither tuiPluginHost nor commands is available; /ws is disabled');
        return;
      }
      try {
        const dispose = commands.register(definition);
        if (typeof dispose === 'function' && typeof ready.effect === 'function') {
          ready.effect(() => dispose, 'workspace-sidebar command');
        }
      } catch (error) {
        warn('/ws registration failed', error);
      }
    }

    /**
     * @param {any} ready
     */
    function mountShortcut(ready) {
      const shortcut = settings.shortcut;
      if (shortcut === '' || shortcut === 'off' || shortcut === 'none') return;
      let shortcuts;
      try {
        shortcuts = ready.get('tuiShortcuts', false);
      } catch {
        shortcuts = undefined;
      }
      if (!shortcuts || typeof shortcuts.register !== 'function') return;
      try {
        const dispose = shortcuts.register(shortcut, {
          description: copy.shortcutDescription,
          handler: () => {
            openPanel();
          },
        }, ready);
        if (typeof dispose === 'function' && typeof ready.effect === 'function') {
          ready.effect(() => dispose, 'workspace-sidebar shortcut');
        }
      } catch (error) {
        warn(`shortcut "${shortcut}" was refused`, error);
      }
    }

    /**
     * @param {any} ready
     */
    function mountPanel(ready) {
      let panels;
      try {
        panels = ready.get('tuiPanels', false);
      } catch (error) {
        warn('tuiPanels is unavailable', error);
        return;
      }
      if (!panels || typeof panels.register !== 'function') {
        warn('tuiPanels is unavailable; the sidebar panel is disabled');
        return;
      }

      const Panel = createPanel({ tracker, config: settings, jump });
      let dispose;
      try {
        dispose = panels.register({
          apiVersion: 1,
          id: PANEL_SUB_ID,
          title: copy.title,
          icon: PANEL_ICON,
          order: PANEL_ORDER,
          component: Panel,
        }, ready);
      } catch (error) {
        warn('the sidebar panel was rejected', error);
        return;
      }
      if (typeof dispose !== 'function') {
        warn('the host rejected the sidebar panel (duplicate id or budget)');
        return;
      }
      if (typeof ready.effect === 'function') {
        try {
          ready.effect(() => dispose, 'workspace-sidebar panel');
        } catch (error) {
          warn('registering the panel lifecycle effect failed', error);
        }
      }

      panelsService = panels;
      panelId = resolvePanelId(panels);
      if (panelId === '') {
        warn('could not resolve the final panel id; the badge and /ws stay off');
      } else {
        tracker.setPanelHandle(panels, panelId);
      }

      if (typeof ready.inject === 'function') {
        ready.inject(['tuiScenes'], mountScene);
        ready.inject(['tuiPluginHost'], mountCommand);
        ready.inject(['tuiShortcuts'], mountShortcut);
      } else {
        mountScene(ready);
        mountCommand(ready);
        mountShortcut(ready);
      }
    }

    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tuiPanels'], mountPanel);
    } else {
      mountPanel(ctx);
    }
  } catch (error) {
    warn('activation failed', error);
  }
}

export default apply;
