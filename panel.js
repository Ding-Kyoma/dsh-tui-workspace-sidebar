/**
 * The sidebar panel itself.
 *
 * One line per conversation, grouped under its project: what is running now,
 * what finished and was never read, and what finished recently enough to stay
 * in reach (seven days by default). Hover highlights, a click jumps (through the
 * transition scene), and the keyboard drives the same actions while the panel
 * is focused. The attached conversation is always listed and is the default
 * selection, so the highlight says where you are before you move it.
 *
 * Every project header carries a `+` after its title: it starts a fresh
 * conversation in that workspace (backgrounding the attached one first when it
 * is still running). The panel has no channel, so the click goes through the
 * same one-shot queue and transition scene as a row jump.
 *
 * The far right of the same header carries a `⧉` that copies the workspace's
 * absolute path to the clipboard and confirms it for a few seconds. `+` keeps
 * its place after the counters; the flexible gap before the copy icon pins that
 * icon to the panel's right edge, so every project's copy target lines up in
 * one column and is easy to hit repeatedly.
 */

import { COPY_TOAST_MS } from './copy.js';
import {
  FRESH_FINISH_MS,
  RUNNING_FRAME_MS,
  RUNNING_FRAMES,
  basename,
  counterGlyph,
  fitGroups,
  formatWhen,
  glyphFor,
  normalizeCwd,
  selectedRow,
} from './model.js';
import { messagesFor, resolveLang } from './strings.js';

/** The copy-a-workspace-path affordance on a project header. */
export const COPY_ICON = '⧉';

/**
 * One wheel notch moves one conversation row.
 *
 * dsh-tui reports a notch as three terminal rows (`deltaY = ±3`), because a
 * transcript line is the unit there. A sidebar row is one conversation, so the
 * same notch should walk one row; scaling by the delta would scroll three
 * conversations per mouse notch and turn a trackpad flick into a jump.
 */
const WHEEL_ROWS = 1;

/**
 * @param {{
 *   tracker: any,
 *   config: {lang?: 'zh' | 'en' | 'auto'},
 *   jump: {
 *     sceneId: string,
 *     sceneReady: () => boolean,
 *     queue: any,
 *     guard?: {arm: (onStranded?: () => void) => void, settle: () => void},
 *   },
 *   copy?: (path: string) => Promise<{ok?: boolean}>,
 *   notify?: (text: string, options?: {timeoutMs?: number, color?: string}) => boolean,
 * }} options
 */
export function createPanel(options) {
  const { tracker, config, jump } = options;
  // Rendering a panel must never touch a clipboard on its own, so the default
  // writer reports a failure instead of falling back to the real one. index.js
  // always injects the activation's writer and toast service.
  const copy = typeof options.copy === 'function' ? options.copy : async () => ({ ok: false });
  const notify = typeof options.notify === 'function' ? options.notify : () => false;

  /**
   * @param {any} props
   */
  return function WorkspaceSidebarPanel(props) {
    const { React, ui, host, width, height, focused, visible } = props;
    const h = React.createElement;
    const { Box, Text } = ui;

    const hostSnapshot = host.snapshot();
    const lang = resolveLang(config.lang, hostSnapshot.lang);
    const strings = messagesFor(lang);
    const data = React.useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);

    const [selectedId, setSelectedId] = React.useState(null);
    const [hoverId, setHoverId] = React.useState(null);
    // The header's `+` keeps its own hover state: overwriting `hoverId` would
    // clear the group's highlight and, because hover does not bubble, the
    // parent would not re-enter when the pointer moves from `+` to the title.
    // The copy icon does the same for the same reason.
    const [plusHoverKey, setPlusHoverKey] = React.useState(null);
    const [copyHoverKey, setCopyHoverKey] = React.useState(null);

    const showHeader = height >= 3;
    const showFooter = height >= 4;
    const capacity = Math.max(1, height - (showHeader ? 1 : 0) - (showFooter ? 1 : 0));

    // The body is a fixed number of lines: when the grouped list would not fit,
    // fold older read conversations until it does (never below three per
    // project). Everything below — selection, keyboard movement, the header
    // total — sees the same fitted view, so the highlight can never sit on a
    // folded row. Running, unread and waiting rows are never folded.
    const view = fitGroups(data.groups, capacity, data.currentId);
    const rows = view.flatRows;
    // Default to the conversation on screen: the panel opens with the highlight
    // where the person actually is, not on the first row of the list.
    const selected = selectedRow(rows, selectedId, data.currentId);
    const selectedRef = React.useRef(undefined);
    selectedRef.current = selected?.id;
    const dataRef = React.useRef(data);
    dataRef.current = data;
    const viewRef = React.useRef(view);
    viewRef.current = view;
    const lastCurrent = React.useRef(data.currentId);

    const running = data.running > 0;
    const tick = ui.useAnimationTime(running ? RUNNING_FRAME_MS : 1000);
    const frame = Math.floor(tick / RUNNING_FRAME_MS) % RUNNING_FRAMES.length;
    const now = Date.now();
    const showTime = width >= 30;

    // Keep the tracker's notion of "the session on screen" and "the panel is
    // visible" up to date. The panel unmounts when another tab is active, so
    // both are reported from the mount lifecycle, not inferred.
    React.useEffect(() => {
      tracker.setCurrent(hostSnapshot.sessionId);
    }, [tracker, hostSnapshot.sessionId]);

    // Following a jump (or any session switch) returns the highlight to the
    // conversation now on screen. Keyboard navigation in between is untouched.
    React.useEffect(() => {
      if (lastCurrent.current === data.currentId) return;
      lastCurrent.current = data.currentId;
      setSelectedId(null);
    }, [data.currentId]);

    React.useEffect(() => {
      tracker.setPanelVisible(visible);
      return () => {
        tracker.setPanelVisible(false);
      };
    }, [tracker, visible]);

    React.useEffect(() => {
      tracker.reconcile();
      tracker.refreshWorkspaces();
    }, [tracker]);

    // A one-second sweep catches title/status changes that arrived without an
    // event this activation heard (for example a session resumed elsewhere).
    const second = Math.floor(tick / 1000);
    const lastSecond = React.useRef(-1);
    React.useEffect(() => {
      if (second === lastSecond.current) return;
      lastSecond.current = second;
      tracker.reconcile();
    }, [tracker, second]);

    /** @type {{type: 'header' | 'row', key: string, group?: any, row?: any}[]} */
    const items = [];
    for (const group of view.groups) {
      items.push({ type: 'header', key: `g:${group.key}`, group });
      for (const row of group.rows) items.push({ type: 'row', key: row.id, row, group });
    }
    const focusIndex = Math.max(0, items.findIndex(item => item.type === 'row' && item.row?.id === selected?.id));
    const maxTop = Math.max(0, items.length - capacity);
    // Start on the conversation now on screen instead of painting the top of
    // the list and letting the follow effect jump down one commit later.
    const [top, setTop] = React.useState(() => {
      if (items.length === 0) return 0;
      return focusIndex >= capacity
        ? Math.max(0, Math.min(maxTop, focusIndex - capacity + 1))
        : 0;
    });
    const safeTop = Math.max(0, Math.min(top, maxTop));

    // Keep the highlighted row visible when the highlight itself moves (the
    // keyboard, a jump, or the attached session changing) or when the panel
    // height changes. Wheel scrolling must NOT run this: `top` is the window
    // the person is browsing, and the old effect also depended on `safeTop`,
    // so every notch was scrolled back to the selection on the next commit —
    // the list bounced in place instead of scrolling.
    const followed = React.useRef({ id: null, capacity: -1 });
    React.useEffect(() => {
      if (items.length === 0) {
        followed.current = { id: null, capacity };
        return;
      }
      const previous = followed.current;
      if (previous.id === selected?.id && previous.capacity === capacity) return;
      followed.current = { id: selected?.id, capacity };
      setTop(current => {
        const base = Math.max(0, Math.min(current, maxTop));
        if (focusIndex < base) return focusIndex;
        if (focusIndex >= base + capacity) return Math.max(0, focusIndex - capacity + 1);
        return current;
      });
    }, [focusIndex, selected?.id, capacity, maxTop, items.length]);

    // Rendering already clamps (`safeTop`), but a stale offset past the end
    // would swallow the first wheel-up notches after the list shrinks or the
    // panel grows. Keep the stored position honest.
    React.useEffect(() => {
      if (top <= maxTop) return;
      setTop(maxTop);
    }, [top, maxTop]);

    function move(delta) {
      const list = viewRef.current.flatRows;
      if (list.length === 0) return;
      const index = list.findIndex(row => row.id === selectedRef.current);
      const base = index < 0 ? (delta > 0 ? -1 : 0) : index;
      const next = Math.max(0, Math.min(list.length - 1, base + delta));
      setSelectedId(list[next].id);
      setHoverId(null);
    }

    function jumpTo(row) {
      const target = row ?? viewRef.current.flatRows.find(item => item.id === selectedRef.current);
      if (!target) return;
      if (target.id === dataRef.current.currentId) {
        host.toast(strings.alreadyHere);
        return;
      }
      if (!jump.sceneReady()) {
        host.toast(strings.jumpUnavailable);
        return;
      }
      jump.queue.request({ id: target.id, title: target.title, cwd: target.cwd, lang });
      // Arm BEFORE the open: the host may accept the scene and still cover it
      // with a pending questionnaire / plan review, in which case the scene
      // never mounts and would hold the panel full-screen forever. The guard
      // closes it again and says why; see createSceneGuard.
      jump.guard?.arm(() => host.toast(strings.jumpPending));
      if (host.openScene(jump.sceneId) !== true) {
        jump.guard?.settle();
        jump.queue.clear();
        host.toast(strings.jumpUnavailable);
      }
    }

    /**
     * Ask the transition scene for a fresh conversation in `cwd`.
     * @param {string} cwd
     * @param {string} [label] workspace title for the scene card / handoff toast
     */
    function requestNew(cwd, label) {
      const path = normalizeCwd(cwd);
      if (path === '') return;
      if (!jump.sceneReady()) {
        host.toast(strings.newUnavailable);
        return;
      }
      jump.queue.request({ kind: 'new', cwd: path, label, lang });
      jump.guard?.arm(() => host.toast(strings.jumpPending));
      if (host.openScene(jump.sceneId) !== true) {
        jump.guard?.settle();
        jump.queue.clear();
        host.toast(strings.newUnavailable);
      }
    }

    function newSessionIn(group) {
      if (!group || typeof group.cwd !== 'string' || group.cwd === '') return;
      requestNew(group.cwd, group.title);
    }

    function newSessionForSelected() {
      const row = viewRef.current.flatRows.find(item => item.id === selectedRef.current);
      if (!row || typeof row.cwd !== 'string' || row.cwd === '') return;
      const key = normalizeCwd(row.cwd);
      const group = viewRef.current.groups.find(item => item.key === key);
      requestNew(row.cwd, group?.title || basename(row.cwd));
    }

    function markSelected() {
      const row = viewRef.current.flatRows.find(item => item.id === selectedRef.current);
      if (!row) return;
      if (row.status === 'running') {
        host.toast(strings.cannotMarkRunning);
        return;
      }
      tracker.markSeen(row.id);
      host.toast(strings.markedRead);
    }

    /**
     * Copy a workspace's absolute path and say so for COPY_TOAST_MS.
     *
     * The host's panel toast is fixed at four seconds, so the activation's
     * `tuiToast` service is tried first (`timeoutMs`) and the plain panel toast
     * is the fallback when that service is unavailable. Neither is awaited: the
     * clipboard write may spawn a helper and the panel must not stall on it.
     *
     * @param {any} group
     */
    function copyPath(group) {
      const path = normalizeCwd(group?.cwd);
      if (path === '') return;
      void (async () => {
        let result;
        try {
          result = await copy(path);
        } catch {
          result = undefined;
        }
        if (result && result.ok === true) {
          let shown = false;
          try {
            shown = notify(strings.copied, { timeoutMs: COPY_TOAST_MS, color: 'success' }) === true;
          } catch {
            shown = false;
          }
          if (!shown) {
            try {
              host.toast(strings.copied);
            } catch {
              // A toast failure must not escape a click handler.
            }
          }
          return;
        }
        try {
          host.toast(strings.copyFailed);
        } catch {
          // Same: feedback is best-effort once the panel is gone.
        }
      })();
    }

    // The handler is registered once per host object; live values come through
    // refs so a re-render does not churn the keyboard listener.
    const moveRef = React.useRef(move);
    moveRef.current = move;
    const jumpRef = React.useRef(jumpTo);
    jumpRef.current = jumpTo;
    const markRef = React.useRef(markSelected);
    markRef.current = markSelected;
    const newRef = React.useRef(newSessionForSelected);
    newRef.current = newSessionForSelected;

    React.useEffect(() => {
      if (typeof host.onKey !== 'function') return undefined;
      return host.onKey(event => {
        const key = event.key ?? {};
        if (key.upArrow) {
          event.preventDefault();
          moveRef.current(-1);
          return;
        }
        if (key.downArrow) {
          event.preventDefault();
          moveRef.current(1);
          return;
        }
        if (key.return) {
          event.preventDefault();
          jumpRef.current();
          return;
        }
        if (event.input === 'm') {
          event.preventDefault();
          markRef.current();
          return;
        }
        if (event.input === 'n') {
          event.preventDefault();
          newRef.current();
          return;
        }
        if (event.input === 'r') {
          event.preventDefault();
          tracker.reconcile();
          tracker.refreshWorkspaces();
        }
      });
    }, [host, tracker]);

    function renderGroup(group) {
      const hovered = hoverId === `g:${group.key}`;
      const plusHovered = plusHoverKey === group.key;
      const copyHovered = copyHoverKey === group.key;
      // Project headers carry status icons, not counts: the same character the
      // rows use for "running" (the chat spinner) and "unread" (the dot), so the
      // folder icon turns in lockstep with the conversation icons. The header
      // keeps its muted chrome colour, and the numbers live in the panel's
      // header total.
      const counts = [];
      if (group.running > 0) counts.push(counterGlyph('running', frame));
      if (group.unread > 0) counts.push(counterGlyph('unread', frame));
      return h(
        Box,
        {
          key: `g:${group.key}`,
          height: 1,
          flexDirection: 'row',
          flexShrink: 0,
          onMouseEnter: () => setHoverId(`g:${group.key}`),
          onMouseLeave: () => setHoverId(current => (current === `g:${group.key}` ? null : current)),
        },
        // The title shrinks before the chrome does: without a shrinkable box a
        // long workspace name would push the counter and the two header actions
        // past the panel edge (a row title is boxed for exactly the same
        // reason). It deliberately does NOT grow — free space belongs to the
        // gap below, which is what pins the copy icon to the right edge.
        h(
          Box,
          { key: `title:${group.key}`, flexShrink: 1, minWidth: 0 },
          h(Text, {
            bold: true,
            dimColor: !hovered,
            color: hovered ? 'accent' : undefined,
            wrap: 'truncate-end',
          }, `▸ ${group.title || strings.unknownProject}`),
        ),
        counts.length > 0
          ? h(
            Box,
            {
              key: `counters:${group.key}`,
              flexShrink: 0,
              marginLeft: 1,
              flexDirection: 'row',
              gap: 1,
            },
            counts.map((char, index) => h(Text, {
              key: `c${index}`,
              dimColor: true,
            }, char)),
          )
          : null,
        // The `+` starts a fresh conversation in this workspace, like `/new`
        // in that cwd. It sits right after the counters; the horizontal padding
        // widens its click target beyond the glyph. It stays outside the title
        // Text so the click is its own hit target; the group header itself has
        // no click action.
        group.cwd !== ''
          ? h(
            Box,
            {
              key: `new:${group.key}`,
              flexShrink: 0,
              paddingX: 1,
              onMouseEnter: () => setPlusHoverKey(group.key),
              onMouseLeave: () => setPlusHoverKey(current => (current === group.key ? null : current)),
              onClick: event => {
                event?.stopImmediatePropagation?.();
                newSessionIn(group);
              },
            },
            h(Text, {
              bold: plusHovered,
              dimColor: !plusHovered,
              color: plusHovered ? 'accent' : undefined,
            }, '+'),
          )
          : null,
        // One flexible cell-less gap takes every spare column, so the copy icon
        // below sits on the panel's right edge for every project. It collapses
        // to zero on a narrow panel instead of hiding the icon.
        group.cwd !== ''
          ? h(Box, { key: `gap:${group.key}`, flexGrow: 1, minWidth: 0 })
          : null,
        // The `⧉` copies this workspace's absolute path to the clipboard and
        // confirms it for a few seconds. The panel has no clipboard API and no
        // channel, so the write is the activation's writer (see copy.js), which
        // reuses dsh-tui's own clipboard implementation. No cwd, no target —
        // the same rule the `+` follows.
        group.cwd !== ''
          ? h(
            Box,
            {
              key: `copy:${group.key}`,
              flexShrink: 0,
              paddingX: 1,
              onMouseEnter: () => setCopyHoverKey(group.key),
              onMouseLeave: () => setCopyHoverKey(current => (current === group.key ? null : current)),
              onClick: event => {
                event?.stopImmediatePropagation?.();
                copyPath(group);
              },
            },
            h(Text, {
              bold: copyHovered,
              dimColor: !copyHovered,
              color: copyHovered ? 'accent' : undefined,
            }, COPY_ICON),
          )
          : null,
      );
    }

    function renderRow(row) {
      const isSelected = selected?.id === row.id;
      const isCurrent = row.id === data.currentId;
      const isHovered = hoverId === row.id;
      // The attached conversation and the keyboard selection are marked with
      // colour and the cursor, never a permanent fill: the loudest row on
      // screen should be the one under the mouse, not the one you are reading.
      const emphasized = isSelected || isCurrent;
      const fresh = row.status === 'finished' && now - row.finishedAt < FRESH_FINISH_MS;
      // A parked question stays bold until it is answered: unlike `fresh`, this
      // is not a short animation but a standing request for attention.
      const waiting = row.waiting === true;
      const bold = emphasized || fresh || waiting;
      const glyph = glyphFor(row, frame);
      const when = showTime ? formatWhen(row.updatedAt, now, lang) : '';
      return h(
        Box,
        {
          key: row.id,
          height: 1,
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: isHovered ? 'userMessageBackgroundHover' : undefined,
          onMouseEnter: () => setHoverId(row.id),
          onMouseLeave: () => setHoverId(current => (current === row.id ? null : current)),
          onClick: event => {
            event?.stopImmediatePropagation?.();
            jumpTo(row);
          },
        },
        h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: focused && isSelected ? 'accent' : undefined }, focused && isSelected ? '❯' : ' ')),
        h(Text, { color: glyph.color, bold, dimColor: glyph.dim }, glyph.char),
        h(Text, null, ' '),
        h(
          Box,
          { flexGrow: 1, flexShrink: 1, minWidth: 0 },
          h(Text, {
            bold,
            color: emphasized ? 'accent' : undefined,
            wrap: 'truncate-end',
          }, row.title || strings.untitled),
        ),
        // The green dot is the same "unread" signal; this suffix is what tells
        // the two apart without inventing a second glyph. It is dropped on a
        // very narrow panel where the title needs every cell.
        waiting && showTime
          ? h(Box, { flexShrink: 0, marginLeft: 1 }, h(Text, { dimColor: true }, strings.waiting))
          : null,
        when !== ''
          ? h(Box, { flexShrink: 0, marginLeft: 1 }, h(Text, { dimColor: true }, when))
          : null,
      );
    }

    const body = items.length === 0
      ? h(
        Box,
        { flexGrow: 1, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', paddingX: 1 },
        h(Text, { dimColor: true, wrap: 'truncate-end' }, strings.emptyTitle),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, data.agentsAvailable ? strings.emptyHint(config.retentionHours) : strings.liveUnavailable),
      )
      : h(
        Box,
        {
          flexGrow: 1,
          flexDirection: 'column',
          overflow: 'hidden',
          onWheel: event => {
            event?.stopImmediatePropagation?.();
            const delta = Number(event?.deltaY);
            if (!Number.isFinite(delta) || delta === 0) return;
            const step = delta > 0 ? WHEEL_ROWS : -WHEEL_ROWS;
            setTop(current => Math.max(0, Math.min(maxTop, current + step)));
          },
        },
        items.slice(safeTop, safeTop + capacity).map(item => (item.type === 'header' ? renderGroup(item.group) : renderRow(item.row))),
      );

    // The host pads its own chrome (PanelBar and the key hint under the rule)
    // by one column; the panel's header and footer do the same, so their text
    // lines up with the host hint below instead of sitting flush on the border.
    // Rows keep the full width: their hover fill should bleed to both edges.
    return h(
      Box,
      { flexDirection: 'column', flexGrow: 1, width: '100%', overflow: 'hidden' },
      showHeader
        ? h(Box, { height: 1, flexShrink: 0, paddingX: 1, overflow: 'hidden' }, h(Text, { dimColor: true, wrap: 'truncate-end' }, strings.header(data.running, data.unread, view.flatRows.length)))
        : null,
      body,
      showFooter
        ? h(Box, { height: 1, flexShrink: 0, paddingX: 1, overflow: 'hidden' }, h(Text, { dimColor: true, wrap: 'truncate-end' }, focused ? strings.hintFocused : strings.hintIdle))
        : null,
    );
  };
}
