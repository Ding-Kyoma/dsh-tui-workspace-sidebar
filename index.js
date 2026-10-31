/**
 * Workspace sidebar — a lightweight right-side panel listing the conversations
 * that are running now, finished unread, or finished recently enough to stay in
 * reach (seven days idle by default), grouped by project.
 *
 * Design notes that explain the shape of this file:
 *
 * - A plugin panel gets no channel, so it cannot call `channel.resumeTo` or
 *   `channel.switchWorkspace` directly. Clicking a row (or a workspace's `+`)
 *   therefore drops a one-shot target in a queue and opens a registered scene,
 *   whose props *do* carry the live channel; the scene performs the resume or
 *   the new-session handoff and closes. That transition card is the only
 *   public-API path to a session switch in dsh-tui 0.17.0.
 * - Everything is feature-detected and fail-open: a missing `agents`,
 *   `tuiPanels`, `tuiScenes`, `tuiWorkspaces`, `tuiPluginHost` or `commands`
 *   degrades that capability instead of failing the activation.
 * - The package ships a `dsh-plugin.json`, so the host admits this activation
 *   and prefixes the panel with the manifest id (`workspace-sidebar:inbox`).
 *   Without that manifest the id would be an anonymous `session:actN:inbox`,
 *   which the settings picker refuses to persist (it has no durable identity).
 *   The id is still re-resolved from `panels.list()` on every activation
 *   instead of being assumed.
 */

import Schema from '@deepseek-ai/schemastery';
import { readAttachedSessionId } from './current.js';
import { JUMP_SCENE_ID, createJumpQueue, createJumpScene } from './jump.js';
import { createPanel } from './panel.js';
import { createQuestionRelay } from './questions.js';
import { DEFAULT_STATE_FILE, createStore } from './store.js';
import { createTracker } from './tracker.js';
import { messagesFor, resolveLang } from './strings.js';

export const name = 'workspace-sidebar';
export const PANEL_SUB_ID = 'inbox';
export const PANEL_ICON = '▣';
export const PANEL_ORDER = 10;
export const DEFAULT_SHORTCUT = 'alt+w';
/** Finished conversations linger this long after their last activity. */
export const DEFAULT_RETENTION_HOURS = 7 * 24;
/** A month is plenty; the 300-row cap bounds memory long before that. */
const MAX_RETENTION_HOURS = 720;

/**
 * Cordis contract: the host validates and defaults a row's `config` against
 * this schema before `apply` runs. The defaults mirror {@link normalizeConfig};
 * range handling stays there so a hand-written value outside the documented
 * window is still tolerated instead of failing activation.
 */
export const Config = Schema.object({
  lang: Schema.union(['auto', 'zh', 'en']).default('auto'),
  stateFile: Schema.string().default(DEFAULT_STATE_FILE),
  shortcut: Schema.string().default(DEFAULT_SHORTCUT),
  retentionHours: Schema.number().default(DEFAULT_RETENTION_HOURS),
  relayQuestions: Schema.boolean().default(true),
});

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * @param {{lang?: unknown, stateFile?: unknown, shortcut?: unknown, retentionHours?: unknown, relayQuestions?: unknown}} [config]
 */
export function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const lang = source.lang === 'zh' || source.lang === 'en' ? source.lang : 'auto';
  const stateFile = typeof source.stateFile === 'string' && source.stateFile.trim() !== ''
    ? source.stateFile.trim()
    : DEFAULT_STATE_FILE;
  const shortcut = typeof source.shortcut === 'string' ? source.shortcut.trim() : DEFAULT_SHORTCUT;
  const hours = Number(source.retentionHours);
  // `0` is meaningful (old behaviour: drop a conversation as soon as it is
  // read); fractions are accepted so the window can be exercised by hand.
  const retentionHours = source.retentionHours === undefined || source.retentionHours === null
    || !Number.isFinite(hours) || hours < 0
    ? DEFAULT_RETENTION_HOURS
    : Math.min(hours, MAX_RETENTION_HOURS);
  // On by default: a background ask currently fails with NO_PROVIDER, and the
  // parking half of the relay is inert as soon as another answerer claims the
  // request. An explicit `false` is the escape hatch for a host that handles
  // background questions natively; the waiting-dot observation of a foreground
  // ask never parks anything, so it stays on either way.
  const relayQuestions = source.relayQuestions !== false;
  return { lang, stateFile, shortcut, retentionHours, relayQuestions };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{lang?: 'zh' | 'en' | 'auto', stateFile?: string, shortcut?: string, retentionHours?: number, relayQuestions?: boolean}} [config]
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
      retentionMs: settings.retentionHours * 60 * 60 * 1000,
      probe: () => readAttachedSessionId(),
    });
    const queue = createJumpQueue();
    let sceneReady = false;
    let panelsService;
    let panelId = '';
    const jump = { sceneId: JUMP_SCENE_ID, queue, sceneReady: () => sceneReady };

    tracker.attach();
    void tracker.load();

    // The relay is always attached. Its observation half paints the waiting dot
    // for a question some other answerer is showing right now — including the
    // attached session, whose asks dsh-tui claims itself — and never takes the
    // ask away from anyone. Its parking half is what `relayQuestions` gates: a
    // background ask has no answerer in dsh-tui 0.17.0, so that half parks it
    // instead of letting the turn fail and re-delivers it only when the inbox
    // jump opens that session. Both halves yield to the host on every request,
    // so the official fix makes parking inert without a code change.
    let relay;
    try {
      relay = createQuestionRelay({
        ctx,
        tracker,
        probe: () => readAttachedSessionId(),
        logger,
        parkQuestions: settings.relayQuestions,
      });
      relay.attach();
    } catch (error) {
      try {
        relay?.dispose();
      } catch {
        // A partially attached relay is still best-effort.
      }
      relay = undefined;
      warn('registering the question relay failed', error);
    }

    if (typeof ctx?.effect === 'function') {
      try {
        ctx.effect(() => () => {
          try {
            relay?.dispose();
          } catch {
            // Disposal is best-effort.
          }
          tracker.dispose();
          void store.close().catch(() => {});
        }, 'workspace-sidebar lifecycle');
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
        warn('tuiScenes is unavailable; sidebar actions are disabled');
        return;
      }
      const Scene = createJumpScene({
        queue,
        tracker,
        config: settings,
        // A background question is released only after this scene has actually
        // adopted the session; the relay itself never forwards on its own.
        deliverQuestion: id => relay?.deliver(id),
      });
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
          // The host refuses the mediated surface when the manifest does not
          // declare this command, or when an older host gives the activation no
          // Component identity. The commands service is a public Cordis service
          // and still accepts an unattributed global definition (C-070).
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
     * Mount the panel and its transition scene from ONE injected context.
     *
     * Ownership in dsh-tui is attributed to the *calling activation context*.
     * `host.openScene()` checks the scene's owner against the panel's owner, so
     * a panel registered from one `ctx.inject` callback cannot open a scene
     * registered from a sibling callback: they are different fibers and the
     * host refuses with "belongs to another activation". Both registrations
     * therefore share this `ready` (the same fiber), which is what makes the
     * panel's click-to-jump work at all.
     *
     * @param {any} ready
     */
    function mountHost(ready) {
      let panels;
      try {
        panels = ready.get('tuiPanels', false);
      } catch (error) {
        warn('tuiPanels is unavailable', error);
      }
      let scenes;
      try {
        scenes = ready.get('tuiScenes', false);
      } catch (error) {
        warn('tuiScenes is unavailable', error);
      }

      if (!panels || typeof panels.register !== 'function') {
        warn('tuiPanels is unavailable; the sidebar panel is disabled');
        return;
      }
      if (!mountPanel(ready, panels)) return;

      if (scenes && typeof scenes.register === 'function') mountScene(ready);
      else warn('tuiScenes is unavailable; sidebar actions are disabled');

      if (typeof ready.inject === 'function') {
        ready.inject(['tuiPluginHost'], mountCommand);
        ready.inject(['tuiShortcuts'], mountShortcut);
      } else {
        mountCommand(ready);
        mountShortcut(ready);
      }
    }

    /**
     * @param {any} ready
     * @param {any} panels
     */
    function mountPanel(ready, panels) {
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
        return false;
      }
      if (typeof dispose !== 'function') {
        warn('the host rejected the sidebar panel (duplicate id or budget)');
        return false;
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
      return true;
    }

    if (typeof ctx?.inject === 'function') {
      // One injection for both: see mountHost() for the ownership reason.
      ctx.inject(['tuiPanels', 'tuiScenes'], mountHost);
    } else {
      mountHost(ctx);
    }
  } catch (error) {
    warn('activation failed', error);
  }
}
