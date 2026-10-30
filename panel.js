/**
 * The sidebar panel itself.
 *
 * One line per conversation, grouped under its project: what is running now,
 * what finished and was never read, and what finished recently enough to stay
 * in reach (six hours by default). Hover highlights, a click jumps (through the
 * transition scene), and the keyboard drives the same actions while the panel
 * is focused. The attached conversation is always listed and is the default
 * selection, so the highlight says where you are before you move it.
 *
 * Every project header carries a `+` after its title: it starts a fresh
 * conversation in that workspace (backgrounding the attached one first when it
 * is still running). The panel has no channel, so the click goes through the
 * same one-shot queue and transition scene as a row jump.
 */

import {
  FRESH_FINISH_MS,
  RUNNING_FRAME_MS,
  RUNNING_FRAMES,
  basename,
  formatWhen,
  glyphFor,
  normalizeCwd,
  selectedRow,
  spinnerGlyph,
} from './model.js';
import { messagesFor, resolveLang } from './strings.js';

/**
 * @param {{
 *   tracker: any,
 *   config: {lang?: 'zh' | 'en' | 'auto'},
 *   jump: {sceneId: string, sceneReady: () => boolean, queue: any},
 * }} options
 */
export function createPanel(options) {
  const { tracker, config, jump } = options;

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
    const [plusHoverKey, setPlusHoverKey] = React.useState(null);
    const [top, setTop] = React.useState(0);

    const rows = data.flatRows;
    // Default to the conversation on screen: the panel opens with the highlight
    // where the person actually is, not on the first row of the list.
    const selected = selectedRow(rows, selectedId, data.currentId);
    const selectedRef = React.useRef(undefined);
    selectedRef.current = selected?.id;
    const dataRef = React.useRef(data);
    dataRef.current = data;
    const lastCurrent = React.useRef(data.currentId);

    const running = data.running > 0;
    const tick = ui.useAnimationTime(running ? RUNNING_FRAME_MS : 1000);
    const frame = Math.floor(tick / RUNNING_FRAME_MS) % RUNNING_FRAMES.length;
    // One spinner character for the header, the project counters and the rows,
    // so every running count animates in lockstep instead of freezing on ⠋.
    const spinner = spinnerGlyph(frame);
    const now = Date.now();
    const showTime = width >= 30;
    const showHeader = height >= 3;
    const showFooter = height >= 4;
    const capacity = Math.max(1, height - (showHeader ? 1 : 0) - (showFooter ? 1 : 0));

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
    for (const group of data.groups) {
      items.push({ type: 'header', key: `g:${group.key}`, group });
      for (const row of group.rows) items.push({ type: 'row', key: row.id, row, group });
    }
    const focusIndex = Math.max(0, items.findIndex(item => item.type === 'row' && item.row?.id === selected?.id));
    const maxTop = Math.max(0, items.length - capacity);
    const safeTop = Math.max(0, Math.min(top, maxTop));

    React.useEffect(() => {
      if (items.length === 0) return;
      if (focusIndex < safeTop) setTop(focusIndex);
      else if (focusIndex >= safeTop + capacity) setTop(Math.max(0, focusIndex - capacity + 1));
      // `items` is rebuilt each render; the numeric inputs are the real deps.
    }, [focusIndex, safeTop, capacity, items.length]);

    function move(delta) {
      const list = dataRef.current.flatRows;
      if (list.length === 0) return;
      const index = list.findIndex(row => row.id === selectedRef.current);
      const base = index < 0 ? (delta > 0 ? -1 : 0) : index;
      const next = Math.max(0, Math.min(list.length - 1, base + delta));
      setSelectedId(list[next].id);
      setHoverId(null);
    }

    function jumpTo(row) {
      const target = row ?? dataRef.current.flatRows.find(item => item.id === selectedRef.current);
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
      if (host.openScene(jump.sceneId) !== true) {
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
      if (host.openScene(jump.sceneId) !== true) {
        jump.queue.clear();
        host.toast(strings.newUnavailable);
      }
    }

    function newSessionIn(group) {
      if (!group || typeof group.cwd !== 'string' || group.cwd === '') return;
      requestNew(group.cwd, group.title);
    }

    function newSessionForSelected() {
      const row = dataRef.current.flatRows.find(item => item.id === selectedRef.current);
      if (!row || typeof row.cwd !== 'string' || row.cwd === '') return;
      const key = normalizeCwd(row.cwd);
      const group = dataRef.current.groups.find(item => item.key === key);
      requestNew(row.cwd, group?.title || basename(row.cwd));
    }

    function markSelected() {
      const row = dataRef.current.flatRows.find(item => item.id === selectedRef.current);
      if (!row) return;
      if (row.status === 'running') {
        host.toast(strings.cannotMarkRunning);
        return;
      }
      tracker.markSeen(row.id);
      host.toast(strings.markedRead);
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
      const counts = [];
      if (group.running > 0) counts.push(`${spinner}${group.running}`);
      if (group.unread > 0) counts.push(`●${group.unread}`);
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
        h(Text, {
          bold: true,
          dimColor: !hovered,
          color: hovered ? 'accent' : undefined,
          wrap: 'truncate-end',
        }, `▾ ${group.title || strings.unknownProject}`),
        // A fresh conversation in this workspace, like `/new` in that cwd.
        // Kept outside the title Text so its click is its own hit target; the
        // group header itself has no click action.
        group.cwd !== ''
          ? h(
            Box,
            {
              key: `new:${group.key}`,
              flexShrink: 0,
              marginLeft: 1,
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
        counts.length > 0
          ? h(Box, { flexShrink: 0, marginLeft: 1 }, h(Text, { dimColor: true }, counts.join(' ')))
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
        h(Text, { color: glyph.color, bold: emphasized || fresh, dimColor: glyph.dim }, glyph.char),
        h(Text, null, ' '),
        h(
          Box,
          { flexGrow: 1, flexShrink: 1, minWidth: 0 },
          h(Text, {
            bold: emphasized || fresh,
            color: emphasized ? 'accent' : undefined,
            wrap: 'truncate-end',
          }, row.title || strings.untitled),
        ),
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
            const delta = event?.deltaY > 0 ? 3 : event?.deltaY < 0 ? -3 : 0;
            if (delta === 0) return;
            setTop(current => Math.max(0, Math.min(maxTop, current + delta)));
          },
        },
        items.slice(safeTop, safeTop + capacity).map(item => (item.type === 'header' ? renderGroup(item.group) : renderRow(item.row))),
      );

    return h(
      Box,
      { flexDirection: 'column', flexGrow: 1, width: '100%', overflow: 'hidden' },
      showHeader
        ? h(Box, { height: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, strings.header(data.running, data.unread, data.flatRows.length, spinner)))
        : null,
      body,
      showFooter
        ? h(Box, { height: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, focused ? strings.hintFocused : strings.hintIdle))
        : null,
    );
  };
}
