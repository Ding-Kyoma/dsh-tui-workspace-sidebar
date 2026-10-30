/**
 * One-click jump from a sidebar row to the conversation it names.
 *
 * A plugin panel gets no channel, so it cannot call `channel.resumeTo` itself.
 * The only public seam that hands a plugin a live channel is a registered
 * scene. The panel therefore leaves a one-shot target in a queue and opens a
 * small transition scene; the scene performs the resume and closes.
 *
 * The scene is a trampoline, not a second inbox: it renders one card for as
 * long as the resume takes and then returns to the chat.
 */

import { RUNNING_FRAME_MS, RUNNING_FRAMES, basename } from './model.js';
import { fmt, messagesFor, resolveLang } from './strings.js';

/** Scene id registered by the plugin. */
export const JUMP_SCENE_ID = 'workspace-sidebar-jump';

/** A stale click target is ignored after this long. */
export const JUMP_TTL_MS = 15_000;

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
     * @param {{id: string, title?: string, cwd?: string, lang?: 'zh' | 'en'}} target
     */
    request(target) {
      if (!target || typeof target.id !== 'string' || target.id === '') return;
      pending = {
        id: target.id,
        title: typeof target.title === 'string' ? target.title : '',
        cwd: typeof target.cwd === 'string' ? target.cwd : '',
        lang: target.lang === 'zh' || target.lang === 'en' ? target.lang : undefined,
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
 * @param {{
 *   queue: ReturnType<typeof createJumpQueue>,
 *   tracker: {markSeen: (id: string) => boolean, setCurrent?: (id: string) => void},
 *   config: {lang?: 'zh' | 'en' | 'auto'},
 * }} options
 */
export function createJumpScene(options) {
  const { queue, tracker, config } = options;

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
      void performJump({
        channel,
        target,
        onSeen: (id) => {
          tracker.markSeen(id);
          tracker.setCurrent?.(id);
        },
        notify: (text) => channel.notify(text, { color: 'error' }),
        close,
      });
      // The scene performs one jump; re-running on channel identity changes
      // would resume twice.
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
        h(Text, { wrap: 'truncate-end' }, title),
        h(Text, { dimColor: true }, `${RUNNING_FRAMES[frame]} ${strings.opening}`),
      ),
    );
  };
}
