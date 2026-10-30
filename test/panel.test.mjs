import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanel } from '../panel.js';
import { RUNNING_FRAMES } from '../model.js';

const NOW = Date.now();

function makeRow(overrides) {
  return {
    id: 'row',
    cwd: '/repo/app',
    title: 'Fix login',
    status: 'finished',
    failed: false,
    updatedAt: NOW - 60_000,
    finishedAt: NOW - 60_000,
    seenAt: NOW - 60_000,
    ...overrides,
  };
}

function snapshot() {
  const rows = [
    makeRow({ id: 'run', title: '给补丁跑个验证', status: 'running', finishedAt: 0, seenAt: 0, updatedAt: NOW - 120_000 }),
    makeRow({ id: 'cur', title: '修复登录页样式' }),
    makeRow({ id: 'unread', title: '重写 README', seenAt: 0 }),
  ];
  return {
    groups: [{ key: '/repo/app', cwd: '/repo/app', title: 'dsh-plugins', running: 1, unread: 1, rows }],
    running: 1,
    unread: 1,
    flatRows: rows,
    currentId: 'cur',
    agentsAvailable: true,
    version: 1,
  };
}

/**
 * A tiny fake React: enough state/refs to drive the panel without a renderer,
 * so the animation and highlight decisions stay unit-testable.
 */
function createHarness(getSnapshot = snapshot, options = {}) {
  const state = new Map();
  const pendingEffects = [];
  const requests = [];
  const opened = [];
  const toasts = [];
  let cursor = 0;
  let tick = 0;
  let depth = 0;
  let keyListener;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = cursor++;
      if (!state.has(index)) state.set(index, typeof initial === 'function' ? initial() : initial);
      const set = next => {
        state.set(index, typeof next === 'function' ? next(state.get(index)) : next);
        render();
      };
      return [state.get(index), set];
    },
    useRef(value) {
      const index = cursor++;
      if (!state.has(index)) state.set(index, { current: value });
      return state.get(index);
    },
    useEffect(fn) {
      pendingEffects.push(fn);
    },
    useSyncExternalStore(_subscribe, getSnapshotFn) {
      return getSnapshotFn();
    },
  };

  const host = {
    snapshot: () => ({ sessionId: 'cur', lang: 'zh' }),
    toast(text) {
      toasts.push(text);
    },
    openScene(id) {
      opened.push(id);
      return options.openScene === undefined ? true : options.openScene(id);
    },
    onKey(listener) {
      keyListener = listener;
      return () => {
        if (keyListener === listener) keyListener = undefined;
      };
    },
  };
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useAnimationTime: () => tick,
  };
  const tracker = {
    subscribe: () => () => {},
    getSnapshot,
    setCurrent() {},
    setPanelVisible() {},
    reconcile() {},
    refreshWorkspaces() {},
    markSeen() {},
  };
  const jump = {
    sceneId: 'jump',
    sceneReady: options.sceneReady ?? (() => true),
    queue: {
      request(target) {
        requests.push(target);
      },
      clear() {
        requests.length = 0;
      },
    },
  };
  const component = createPanel({ tracker, config: { lang: 'zh' }, jump });

  function render() {
    cursor = 0;
    depth += 1;
    const tree = component({ React, ui, host, width: 40, height: 10, focused: true, visible: true });
    depth -= 1;
    if (depth === 0) {
      // Mount effects once the tree is built, like React does after a commit.
      while (pendingEffects.length > 0) pendingEffects.shift()();
    }
    return tree;
  }

  return {
    render,
    setTick(value) {
      tick = value;
    },
    requests,
    opened,
    toasts,
    /** Deliver a focused-panel key event and return it (for defaultPrevented). */
    press(input, key = {}) {
      const event = {
        input,
        key,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      keyListener?.(event);
      return event;
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return node.children.map(textOf).join('');
}

function textLines(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) textLines(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.type === 'Text') {
    out.push(textOf(node));
    return out;
  }
  for (const child of node.children ?? []) textLines(child, out);
  return out;
}

function findBox(node, key) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findBox(child, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.type === 'Box' && node.props?.key === key) return node;
  for (const child of node.children ?? []) {
    const hit = findBox(child, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Every Text node in the tree, so styling can be asserted on the actual leaf. */
function textNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) textNodes(child, out);
    return out;
  }
  if (node.type === 'Text') {
    out.push(node);
    return out;
  }
  for (const child of node.children ?? []) textNodes(child, out);
  return out;
}

/** Direct Text children of a row: the glyph and its spacer (the rest are boxed). */
function directTexts(node) {
  return (node.children ?? []).filter(child => child?.type === 'Text');
}

test('panel: the header and project counters follow the shared animation frame', () => {
  const harness = createHarness();
  const first = textLines(harness.render());
  assert.ok(first.includes(`⠋ 1 运行 · ● 1 未读`), first.join('\n'));
  assert.ok(first.some(line => line.includes('⠋1')), first.join('\n'));

  harness.setTick(400); // floor(400 / 80) % 10 = 5
  const second = textLines(harness.render());
  const frame = RUNNING_FRAMES[5];
  assert.equal(frame, '⠴');
  assert.ok(second.includes(`${frame} 1 运行 · ● 1 未读`), second.join('\n'));
  assert.ok(second.some(line => line.includes(`${frame}1`)), second.join('\n'));
});

test('panel: the current row has no fill, hover fills it and leaving clears it', () => {
  const harness = createHarness();
  const tree = harness.render();

  const current = findBox(tree, 'cur');
  assert.ok(current, 'the attached conversation is rendered');
  assert.equal(current.props.backgroundColor, undefined, 'the current row is not filled');

  const run = findBox(tree, 'run');
  assert.ok(run, 'the running row is rendered');
  run.props.onMouseEnter();
  const hovered = findBox(harness.render(), 'run');
  assert.equal(hovered.props.backgroundColor, 'userMessageBackgroundHover');
  assert.equal(findBox(harness.render(), 'cur').props.backgroundColor, undefined);

  hovered.props.onMouseLeave();
  const cleared = findBox(harness.render(), 'run');
  assert.equal(cleared.props.backgroundColor, undefined);
});

test('panel: only a running plan-mode row spins in the plan colour', () => {
  const planRow = makeRow({
    id: 'plan',
    title: '规划重构',
    status: 'running',
    plan: true,
    finishedAt: 0,
    seenAt: 0,
    updatedAt: NOW - 90_000,
  });
  const plainRow = makeRow({
    id: 'run',
    title: '给补丁跑个验证',
    status: 'running',
    plan: false,
    finishedAt: 0,
    seenAt: 0,
    updatedAt: NOW - 120_000,
  });
  const rows = [planRow, plainRow, makeRow({ id: 'cur', title: '修复登录页样式' })];
  const harness = createHarness(() => ({
    groups: [{ key: '/repo/app', cwd: '/repo/app', title: 'dsh-plugins', running: 2, unread: 0, rows }],
    running: 2,
    unread: 0,
    flatRows: rows,
    currentId: 'cur',
    agentsAvailable: true,
    version: 1,
  }));

  const tree = harness.render();
  const planGlyph = directTexts(findBox(tree, 'plan'))[0];
  assert.equal(textOf(planGlyph), RUNNING_FRAMES[0]);
  assert.equal(planGlyph.props.color, 'planMode');

  const plainGlyph = directTexts(findBox(tree, 'run'))[0];
  assert.equal(textOf(plainGlyph), RUNNING_FRAMES[0]);
  assert.equal(plainGlyph.props.color, 'suggestion');

  // The header total and the project counter keep their muted, uncoloured look.
  const texts = textNodes(tree);
  const header = texts.find(node => textOf(node).includes('2 运行'));
  assert.ok(header, 'the header total is rendered');
  assert.equal(header.props.color, undefined);
  assert.equal(header.props.dimColor, true);
  const counter = texts.find(node => textOf(node) === `${RUNNING_FRAMES[0]}2`);
  assert.ok(counter, 'the project counter is rendered');
  assert.equal(counter.props.color, undefined);
  assert.equal(counter.props.dimColor, true);
});

test('panel: project headings use a right-pointing triangle', () => {
  const lines = textLines(createHarness().render());
  assert.ok(lines.includes('▸ dsh-plugins'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('▾')), lines.join('\n'));
});

test('panel: every real workspace header offers a + new-session target', () => {
  const harness = createHarness();
  const plus = findBox(harness.render(), 'new:/repo/app');
  assert.ok(plus, 'the workspace header renders the + target');
  assert.equal(textOf(plus), '+');

  plus.props.onClick({ stopImmediatePropagation() {} });
  assert.deepEqual(harness.requests, [
    { kind: 'new', cwd: '/repo/app', label: 'dsh-plugins', lang: 'zh' },
  ]);
  assert.deepEqual(harness.opened, ['jump']);
});

test('panel: the + is the last cell on the header line, past the counters', () => {
  const harness = createHarness();
  const header = findBox(harness.render(), 'g:/repo/app');
  const children = header.children;
  const counterIndex = children.findIndex(child => textOf(child).includes(`${RUNNING_FRAMES[0]}1`));
  const plusIndex = children.findIndex(child => child?.props?.key === 'new:/repo/app');
  assert.ok(counterIndex >= 0, 'the running counter is on the line');
  assert.ok(plusIndex > counterIndex, 'the + follows the counter');
  assert.equal(plusIndex, children.length - 1, 'the + is the last cell');
  assert.equal(children[plusIndex - 1].props.flexGrow, 1, 'a spacer pushes it right');
  assert.equal(children[plusIndex].props.paddingX, 1, 'the hit target is wider than the glyph');
  assert.equal(textOf(children[plusIndex]), '+');
});

test('panel: the + highlights on hover without filling the header', () => {
  const harness = createHarness();
  const plus = findBox(harness.render(), 'new:/repo/app');
  assert.equal(directTexts(plus)[0].props.dimColor, true);

  plus.props.onMouseEnter();
  const hovered = findBox(harness.render(), 'new:/repo/app');
  const text = directTexts(hovered)[0];
  assert.equal(text.props.color, 'accent');
  assert.equal(text.props.bold, true);
  assert.equal(findBox(harness.render(), 'g:/repo/app').props.backgroundColor, undefined);

  hovered.props.onMouseLeave();
  assert.equal(directTexts(findBox(harness.render(), 'new:/repo/app'))[0].props.dimColor, true);
});

test('panel: a group without a cwd gets no +', () => {
  const rows = [makeRow({ id: 'cur', cwd: '' })];
  const harness = createHarness(() => ({
    groups: [{ key: 'unknown', cwd: '', title: '', running: 0, unread: 0, rows }],
    running: 0,
    unread: 0,
    flatRows: rows,
    currentId: 'cur',
    agentsAvailable: true,
    version: 1,
  }));
  assert.equal(findBox(harness.render(), 'new:unknown'), undefined);
});

test('panel: clicking + without a scene toasts instead of queueing', () => {
  const harness = createHarness(snapshot, { sceneReady: () => false });
  const plus = findBox(harness.render(), 'new:/repo/app');
  plus.props.onClick({ stopImmediatePropagation() {} });
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.toasts.length, 1);
  assert.ok(harness.toasts[0].includes('场景'), harness.toasts[0]);
});

test('panel: n creates a session in the selected row workspace', () => {
  const harness = createHarness();
  harness.render();
  const event = harness.press('n');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.requests, [
    { kind: 'new', cwd: '/repo/app', label: 'dsh-plugins', lang: 'zh' },
  ]);
  assert.deepEqual(harness.opened, ['jump']);
});
