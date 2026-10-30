/**
 * The sidebar panel itself.
 *
 * One line per conversation, grouped under its project. Only two things are
 * listed: what is running now, and what finished but has not been looked at.
 * Hover highlights, a click jumps (through the transition scene), and the
 * keyboard drives the same actions while the panel is focused.
 */

import { FRESH_FINISH_MS, RUNNING_FRAME_MS, RUNNING_FRAMES, formatWhen, glyphFor } from './model.js';
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
    const [top, setTop] = React.useState(0);

    const rows = data.flatRows;
    const selected = rows.find(row => row.id === selectedId) ?? rows[0];
    const selectedRef = React.useRef(undefined);
    selectedRef.current = selected?.id;
    const dataRef = React.useRef(data);
    dataRef.current = data;

    const running = data.running > 0;
    const tick = ui.useAnimationTime(running ? RUNNING_FRAME_MS : 1000);
    const frame = Math.floor(tick / RUNNING_FRAME_MS) % RUNNING_FRAMES.length;
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
        if (event.input === 'r') {
          event.preventDefault();
          tracker.reconcile();
          tracker.refreshWorkspaces();
        }
      });
    }, [host, tracker]);

    function renderGroup(group) {
      const hovered = hoverId === `g:${group.key}`;
      const counts = [];
      if (group.running > 0) counts.push(`⠋${group.running}`);
      if (group.unread > 0) counts.push(`✓${group.unread}`);
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
        counts.length > 0
          ? h(Box, { flexShrink: 0, marginLeft: 1 }, h(Text, { dimColor: true }, counts.join(' ')))
          : null,
      );
    }

    function renderRow(row) {
      const isSelected = selected?.id === row.id;
      const isHovered = hoverId === row.id;
      const highlighted = isSelected || isHovered;
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
          backgroundColor: highlighted ? 'userMessageBackgroundHover' : undefined,
          onMouseEnter: () => setHoverId(row.id),
          onMouseLeave: () => setHoverId(current => (current === row.id ? null : current)),
          onClick: event => {
            event?.stopImmediatePropagation?.();
            jumpTo(row);
          },
        },
        h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: focused && isSelected ? 'accent' : undefined }, focused && isSelected ? '❯' : ' ')),
        h(Text, { color: glyph.color, bold: fresh || highlighted }, glyph.char),
        h(Text, null, ' '),
        h(
          Box,
          { flexGrow: 1, flexShrink: 1, minWidth: 0 },
          h(Text, {
            bold: highlighted || fresh,
            color: highlighted ? 'accent' : undefined,
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
        h(Text, { dimColor: true, wrap: 'truncate-end' }, data.agentsAvailable ? strings.emptyHint : strings.liveUnavailable),
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
        ? h(Box, { height: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, strings.header(data.running, data.unread)))
        : null,
      body,
      showFooter
        ? h(Box, { height: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, focused ? strings.hintFocused : strings.hintIdle))
        : null,
    );
  };
}
