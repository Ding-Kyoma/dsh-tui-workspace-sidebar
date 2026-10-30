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
function createHarness(getSnapshot = snapshot) {
  const state = new Map();
  let cursor = 0;
  let tick = 0;

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
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };

  const host = {
    snapshot: () => ({ sessionId: 'cur', lang: 'zh' }),
    toast() {},
    openScene: () => true,
    onKey: () => () => {},
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
  const jump = { sceneId: 'jump', sceneReady: () => true, queue: { request() {}, clear() {} } };
  const component = createPanel({ tracker, config: { lang: 'zh' }, jump });

  function render() {
    cursor = 0;
    return component({ React, ui, host, width: 40, height: 10, focused: true, visible: true });
  }

  return {
    render,
    setTick(value) {
      tick = value;
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
