/**
 * One-click transitions from a sidebar row or workspace header.
 *
 * A plugin panel gets no channel, so it cannot call `channel.resumeTo` or
 * `channel.switchWorkspace` itself. The only public seam that hands a plugin a
 * live channel is a registered scene. The panel therefore leaves a one-shot
 * target in a queue and opens a small transition scene; the scene performs the
 * action and closes.
 *
 * Two kinds of target share that seam:
 *
 * - `jump` — resume the conversation a row names (`channel.resumeTo`);
 * - `new` — create a fresh conversation in the workspace a group header names
 *   (`/new` or a workspace handoff), backgrounding the attached session first
 *   when it is still inside a turn.
 *
 * The scene is a trampoline, not a second inbox: it renders one card for as
 * long as the transition takes and then returns to the chat.
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNNING_FRAME_MS, RUNNING_FRAMES, basename, normalizeCwd } from './model.js';
import { fmt, messagesFor, resolveLang } from './strings.js';

/** Scene id registered by the plugin. */
export const JUMP_SCENE_ID = 'workspace-sidebar-jump';

/** A stale click target is ignored after this long. */
export const JUMP_TTL_MS = 15_000;

/** Resume the conversation a row names. */
export const KIND_JUMP = 'jump';

/** Create a fresh conversation in the workspace a group header names. */
export const KIND_NEW = 'new';

/**
 * @param {{now?: () => number, ttl?: number}} [options]
 */
export function createJumpQueue(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const ttl = Number.isFinite(options.ttl) && options.ttl > 0 ? options.ttl : JUMP_TTL_MS;
  /** @type {any} */
  let pending;

  return {
    /**
     * @param {{id?: string, kind?: 'jump' | 'new', title?: string, cwd?: string, label?: string, lang?: 'zh' | 'en'}} target
     */
    request(target) {
      if (!target || typeof target !== 'object') return;
      const kind = target.kind === KIND_NEW ? KIND_NEW : KIND_JUMP;
      const lang = target.lang === 'zh' || target.lang === 'en' ? target.lang : undefined;
      if (kind === KIND_NEW) {
        const cwd = normalizeCwd(target.cwd);
        if (cwd === '') return;
        pending = {
          kind,
          cwd,
          label: typeof target.label === 'string' ? target.label : '',
          lang,
          at: clock(),
        };
        return;
      }
      if (typeof target.id !== 'string' || target.id === '') return;
      pending = {
        kind,
        id: target.id,
        title: typeof target.title === 'string' ? target.title : '',
        cwd: typeof target.cwd === 'string' ? target.cwd : '',
        lang,
        at: clock(),
      };
    },
    /** @returns {any} */
    take() {
      if (pending === undefined) return undefined;
      const target = pending;
      pending = undefined;
      if (clock() - target.at > ttl) return undefined;
      return target;
    },
    clear() {
      pending = undefined;
    },
    /** @returns {any} */
    peek() {
      return pending;
    },
  };
}

/**
 * The `TuiWorkspaceTarget` a workspace handoff needs.
 *
 * The group key is a plain cwd, so the target is a local one. `description`
 * becomes the live `displayCwd` after the adoption (the status bar should show
 * the path, not a `file://` URI); `uri` stays canonical for notices and any
 * provider that resolves it.
 *
 * @param {unknown} cwd
 * @param {unknown} [label]
 * @returns {{kind: 'local', cwd: string, uri: string, label: string, description: string, badge: string} | undefined}
 */
export function workspaceTargetFor(cwd, label) {
  const path = normalizeCwd(cwd);
  if (path === '') return undefined;
  const name = typeof label === 'string' ? label.trim() : '';
  return {
    kind: 'local',
    cwd: path,
    uri: isAbsolute(path) ? pathToFileURL(path).href : path,
    label: name !== '' ? name : basename(path),
    description: path,
    badge: '',
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * Resume `target` through the scene's channel.
 *
 * Extracted from the React component so the failure matrix is testable without
 * a renderer. `close` always runs, including on failure.
 *
 * @param {{
 *   channel: any,
 *   target: {id: string, title?: string, cwd?: string, lang?: 'zh' | 'en'} | undefined,
 *   onSeen?: (id: string) => void,
 *   onOpened?: (id: string) => void,
 *   notify?: (text: string) => void,
 *   close?: () => void,
 * }} input
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function performJump(input) {
  const { channel, target } = input;
  const lang = target?.lang === 'zh' ? 'zh' : target?.lang === 'en' ? 'en' : resolveLang(undefined);
  const strings = messagesFor(lang);
  const notify = (text) => {
    try {
      input.notify?.(text);
    } catch {
      // A toast failure must not strand the scene.
    }
  };
  const done = (result) => {
    try {
      input.close?.();
    } catch {
      // Closing is best-effort; the host also owns the scene.
    }
    return result;
  };

  if (!target || typeof target.id !== 'string' || target.id === '') {
    return done({ ok: false, reason: 'cancelled' });
  }
  if (!channel || typeof channel.resumeTo !== 'function') {
    notify(strings.jumpUnavailable);
    return done({ ok: false, reason: 'unavailable' });
  }

  let result;
  try {
    result = await channel.resumeTo(target.id);
  } catch (error) {
    notify(fmt(strings.openError, { err: messageOf(error) }));
    return done({ ok: false, reason: 'failed' });
  }

  if (result && result.ok === true) {
    try {
      input.onSeen?.(target.id);
    } catch {
      // Marking the row read is a convenience; the switch already happened.
    }
    try {
      input.onOpened?.(target.id);
    } catch {
      // Releasing a parked question must not turn a successful jump into a
      // failure; the inbox row still shows the waiting dot.
    }
    return done({ ok: true });
  }

  const reason = result && typeof result.reason === 'string' ? result.reason : 'unknown';
  switch (reason) {
    case 'working':
      notify(strings.openWorking);
      break;
    case 'occupied':
      notify(fmt(strings.openOccupied, { pid: result?.pid ?? '?' }));
      break;
    case 'cancelled':
      notify(strings.openCancelled);
      break;
    case 'failed':
      notify(fmt(strings.openError, { err: result?.error || strings.openUnknown }));
      break;
    case 'unavailable':
      // The adapter already toasted "unavailable"; a second toast would stack.
      break;
    default:
      notify(strings.openUnknown);
      break;
  }
  return done({ ok: false, reason });
}

/**
 * Start a fresh conversation in `target.cwd`, keeping the attached one when it
 * is still working.
 *
 * Decision table (the host's own gates are unchanged):
 *
 * - idle, same workspace  → `newSession()` (`/new`, no "workspace switched" toast)
 * - idle, other workspace → `switchWorkspace(target)`
 * - working, same         → `backgroundCurrent()` (`/bg` already made the fresh
 *                           session in the current cwd; switching again would
 *                           create a second, empty one)
 * - working, other        → `backgroundCurrent()` then `switchWorkspace(target)`
 *
 * The channel owns the toasts for a refused switch (working gate, missing
 * directory, a failed handoff), so a `false` result closes quietly here; only
 * exceptions and an unsupported kernel get a plugin toast.
 *
 * @param {{
 *   channel: any,
 *   target: {kind?: string, cwd?: string, label?: string, lang?: 'zh' | 'en'} | undefined,
 *   notify?: (text: string) => void,
 *   close?: () => void,
 * }} input
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function performNewSession(input) {
  const { channel, target } = input;
  const lang = target?.lang === 'zh' ? 'zh' : target?.lang === 'en' ? 'en' : resolveLang(undefined);
  const strings = messagesFor(lang);
  const notify = (text) => {
    try {
      input.notify?.(text);
    } catch {
      // A toast failure must not strand the scene.
    }
  };
  const done = (result) => {
    try {
      input.close?.();
    } catch {
      // Closing is best-effort; the host also owns the scene.
    }
    return result;
  };

  const desired = normalizeCwd(target?.cwd);
  if (target === undefined || target.kind !== KIND_NEW || desired === '') {
    return done({ ok: false, reason: 'cancelled' });
  }
  if (!channel || typeof channel !== 'object') {
    notify(strings.newUnsupported);
    return done({ ok: false, reason: 'unavailable' });
  }

  const current = normalizeCwd(channel.cwd);
  const same = current === desired;
  const canNew = typeof channel.newSession === 'function';
  const canSwitch = typeof channel.switchWorkspace === 'function';
  if ((same && !canNew && !canSwitch) || (!same && !canSwitch)) {
    notify(strings.newUnsupported);
    return done({ ok: false, reason: 'unavailable' });
  }

  // Only park a conversation that is actually mid-turn: `/bg` keeps it alive
  // as a background session. An idle one is replaced /new-style and stays
  // listed as a finished row, which is cheaper.
  if (channel.working === true && typeof channel.backgroundCurrent === 'function') {
    let backgrounded;
    try {
      backgrounded = await channel.backgroundCurrent();
    } catch (error) {
      notify(fmt(strings.newError, { err: messageOf(error) }));
      return done({ ok: false, reason: 'failed' });
    }
    if (!backgrounded || backgrounded.ok !== true) {
      // `/bg` toasts its own reasons on most paths; this line guarantees
      // feedback when a backend declines silently.
      notify(strings.newBackgroundFailed);
      return done({ ok: false, reason: 'background-failed' });
    }
    // `/bg` put a fresh session in the workspace being left. If that is the
    // requested one, it is already the answer.
    if (same) return done({ ok: true });
    // Otherwise the fresh session is idle, so the handoff below may proceed.
  }

  if (same && canNew) {
    let created;
    try {
      created = await channel.newSession();
    } catch (error) {
      notify(fmt(strings.newError, { err: messageOf(error) }));
      return done({ ok: false, reason: 'failed' });
    }
    return created === true ? done({ ok: true }) : done({ ok: false, reason: 'refused' });
  }

  const workspace = workspaceTargetFor(desired, target.label);
  if (workspace === undefined) {
    notify(strings.newUnsupported);
    return done({ ok: false, reason: 'unavailable' });
  }
  let switched;
  try {
    switched = await channel.switchWorkspace(workspace);
  } catch (error) {
    notify(fmt(strings.newError, { err: messageOf(error) }));
    return done({ ok: false, reason: 'failed' });
  }
  return switched === true ? done({ ok: true }) : done({ ok: false, reason: 'refused' });
}

/**
 * @param {{
 *   queue: ReturnType<typeof createJumpQueue>,
 *   tracker: {markSeen: (id: string) => boolean, setCurrent?: (id: string) => void},
 *   config: {lang?: 'zh' | 'en' | 'auto'},
 *   deliverQuestion?: (id: string) => void,
 * }} options
 */
export function createJumpScene(options) {
  const { queue, tracker, config, deliverQuestion } = options;

  /**
   * @param {any} props
   */
  return function WorkspaceSidebarJumpScene(props) {
    const { React, ui, channel, close } = props;
    const h = React.createElement;
    const { Box, Text, useInput, useTerminalSize, useAnimationFrame } = ui;
    const size = useTerminalSize();
    const [, animTime] = useAnimationFrame(RUNNING_FRAME_MS);
    const frame = Math.floor(animTime / RUNNING_FRAME_MS) % RUNNING_FRAMES.length;
    const [target] = React.useState(() => queue.take());
    const started = React.useRef(false);
    const lang = target?.lang === 'zh' ? 'zh' : target?.lang === 'en' ? 'en' : resolveLang(config?.lang);
    const strings = messagesFor(lang);
    const creating = target?.kind === KIND_NEW;

    useInput((_input, key) => {
      if (key.escape) close();
    });

    React.useEffect(() => {
      if (started.current) return;
      started.current = true;
      if (target === undefined) {
        close();
        return;
      }
      const notify = (text) => channel.notify(text, { color: 'error' });
      if (creating) {
        void performNewSession({ channel, target, notify, close });
        return;
      }
      void performJump({
        channel,
        target,
        onSeen: (id) => {
          tracker.markSeen(id);
          tracker.setCurrent?.(id);
        },
        // The jump is the explicit "open this conversation" action, so this is
        // the only place a parked background question is released to the TUI.
        onOpened: (id) => deliverQuestion?.(id),
        notify,
        close,
      });
      // The scene performs one transition; re-running on channel identity
      // changes would act twice.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const project = target?.cwd ? basename(target.cwd) : '';
    const title = target?.title || strings.untitled;
    const width = Math.max(20, Math.min(size.columns - 4, 60));

    return h(
      Box,
      { flexDirection: 'column', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
      h(
        Box,
        { flexDirection: 'column', width, paddingX: 1 },
        h(Text, { bold: true, wrap: 'truncate-end' }, `▣ ${project || strings.unknownProject}`),
        creating ? null : h(Text, { wrap: 'truncate-end' }, title),
        h(Text, { dimColor: true }, `${RUNNING_FRAMES[frame]} ${creating ? strings.newOpening : strings.opening}`),
      ),
    );
  };
}
