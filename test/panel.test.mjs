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
 * `projects` workspaces with ten already-read conversations each — the shape
 * the tracker hands to the panel once its per-project cap has been applied.
 * Rows are newest-first inside a group, as buildGroups sorts them.
 */
function manyDoneSnapshot({ projects = 2, current = 'p0-done-9' } = {}) {
  const groups = [];
  for (let project = 0; project < projects; project += 1) {
    const rows = [];
    for (let index = 0; index < 10; index += 1) {
      const at = NOW - 60_000 - (10 - index) * 60_000;
      rows.push(makeRow({
        id: `p${project}-done-${index}`,
        cwd: `/repo/p${project}`,
        title: `项目${project} 会话${index}`,
        updatedAt: at,
        finishedAt: at,
        seenAt: at,
      }));
    }
    rows.reverse();
    groups.push({
      key: `/repo/p${project}`,
      cwd: `/repo/p${project}`,
      title: `项目${project}`,
      running: 0,
      unread: 0,
      rows,
    });
  }
  return {
    groups,
    running: 0,
    unread: 0,
    flatRows: groups.flatMap(group => group.rows),
    currentId: current,
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
    const tree = component({ React, ui, host, width: 40, height: options.height ?? 10, focused: options.focused ?? true, visible: true });
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

/** Find the Box that renders exactly `text` (a single-line chrome box). */
function findBoxByText(node, text) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findBoxByText(child, text);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.type === 'Box' && textOf(node) === text) return node;
  for (const child of node.children ?? []) {
    const hit = findBoxByText(child, text);
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

test('panel: project counters and rows animate while the header stays static', () => {
  const harness = createHarness();
  const first = textLines(harness.render());
  assert.ok(first.includes(' 1 运行 · ● 1 未读'), first.join('\n'));

  const firstCounter = findBox(harness.render(), 'counters:/repo/app');
  assert.ok(firstCounter, 'the project counter is rendered');
  const firstGlyphs = directTexts(firstCounter);
  assert.deepEqual(firstGlyphs.map(textOf), ['⠋', '●'], 'status icons only, no counts');
  assert.equal(firstGlyphs[0].props.color, undefined, 'the header keeps its muted chrome colour');
  assert.equal(firstGlyphs[1].props.color, undefined);
  assert.equal(firstGlyphs[0].props.dimColor, true);
  assert.equal(firstGlyphs[1].props.dimColor, true);

  harness.setTick(400); // floor(400 / 80) % 10 = 5
  const second = textLines(harness.render());
  const frame = RUNNING_FRAMES[5];
  assert.equal(frame, '⠴');
  assert.ok(second.includes(' 1 运行 · ● 1 未读'), 'the header total stays still');

  const counterGlyphs = directTexts(findBox(harness.render(), 'counters:/repo/app'));
  const runGlyph = directTexts(findBox(harness.render(), 'run'))[0];
  assert.equal(textOf(counterGlyphs[0]), frame, 'the project counter still spins');
  assert.equal(textOf(runGlyph), frame, 'the running row glyph still spins');
  assert.equal(counterGlyphs[0].props.color, undefined, 'the folder icon stays muted');
  assert.equal(counterGlyphs[0].props.dimColor, true);
  assert.equal(runGlyph.props.color, 'suggestion', 'the row keeps its running colour');
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

  // The header total is plain text and carries no spinner. The project counter
  // is icon-only, keeps the header's muted colour, and never takes the plan
  // colour (that belongs to the row).
  const texts = textNodes(tree);
  const header = texts.find(node => textOf(node).includes('2 运行'));
  assert.ok(header, 'the header total is rendered');
  assert.equal(header.props.color, undefined);
  assert.equal(header.props.dimColor, true);
  assert.doesNotMatch(textOf(header), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  const counter = directTexts(findBox(tree, 'counters:/repo/app'));
  assert.equal(counter.length, 1, 'running only: one status icon');
  assert.equal(textOf(counter[0]), RUNNING_FRAMES[0]);
  assert.equal(counter[0].props.color, undefined);
  assert.equal(counter[0].props.dimColor, true);
  assert.doesNotMatch(textOf(counter[0]), /\d/);
});

test('panel: project counters are icon-only and share the header gap', () => {
  const tree = createHarness().render();
  const counter = findBox(tree, 'counters:/repo/app');
  assert.ok(counter, 'the project counter is rendered');
  assert.equal(counter.props.flexDirection, 'row');
  assert.equal(counter.props.gap, 1, 'the two status icons stay one cell apart');
  const glyphs = directTexts(counter);
  assert.deepEqual(glyphs.map(textOf), ['⠋', '●']);
  assert.doesNotMatch(textOf(counter), /\d/, 'the project header carries no counts');
  assert.equal(glyphs[0].props.dimColor, true);
  assert.equal(glyphs[1].props.dimColor, true);
  assert.equal(glyphs[0].props.color, undefined);
  assert.equal(glyphs[1].props.color, undefined);
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

test('panel: the + follows the counters with padding on both sides', () => {
  const harness = createHarness();
  const header = findBox(harness.render(), 'g:/repo/app');
  const children = header.children;
  const counterIndex = children.findIndex(child => child?.props?.key === 'counters:/repo/app');
  const plusIndex = children.findIndex(child => child?.props?.key === 'new:/repo/app');
  assert.ok(counterIndex >= 0, 'the status icons are on the line');
  assert.equal(plusIndex, counterIndex + 1, 'the + sits directly after the counters');
  assert.equal(children.length, plusIndex + 1, 'nothing is pushed past the +');
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

test('panel: header and footer keep the host chrome padding', () => {
  // The host pads its PanelBar and the key hint under the rule by one column;
  // unpadded plugin chrome would sit flush on the border next to them.
  const cases = [
    { focused: false, hint: '点击行跳转 · + 新建' },
    { focused: true, hint: '↑↓ 选择 · Enter 跳转 · n 新建 · m 已读 · r 刷新' },
  ];
  for (const { focused, hint } of cases) {
    const harness = createHarness(snapshot, { focused });
    const tree = harness.render();
    const header = findBoxByText(tree, ' 1 运行 · ● 1 未读');
    assert.ok(header, 'the header is rendered');
    assert.equal(header.props.paddingX, 1, 'the header clears the panel edge');
    const footer = findBoxByText(tree, hint);
    assert.ok(footer, `the ${focused ? 'focused' : 'idle'} footer is rendered`);
    assert.equal(footer.props.paddingX, 1, 'the footer clears the panel edge');
  }
});

test('panel: a waiting row shows the green dot, stays bold, and says waiting', () => {
  const waitingRow = makeRow({
    id: 'wait',
    title: '后台计划',
    status: 'running',
    finishedAt: 0,
    seenAt: 0,
    updatedAt: NOW - 10_000,
    runningAt: NOW - 20_000,
    waiting: true,
    waitingAt: NOW - 5_000,
  });
  const rows = [waitingRow, makeRow({ id: 'cur', title: '修复登录页样式' })];
  const harness = createHarness(() => ({
    groups: [{ key: '/repo/app', cwd: '/repo/app', title: 'dsh-plugins', running: 1, unread: 1, rows }],
    running: 1,
    unread: 1,
    flatRows: rows,
    currentId: 'cur',
    agentsAvailable: true,
    version: 1,
  }));
  const tree = harness.render();
  const rowBox = findBox(tree, 'wait');
  const glyph = directTexts(rowBox)[0];
  assert.equal(textOf(glyph), '●');
  assert.equal(glyph.props.color, 'success');
  assert.equal(glyph.props.bold, true);
  const title = textNodes(rowBox).find(node => textOf(node) === '后台计划');
  assert.ok(title, 'the row title is rendered');
  assert.equal(title.props.bold, true);
  const lines = textLines(tree);
  assert.ok(lines.includes('待回答'), lines.join('\n'));
  assert.ok(lines.includes(' 1 运行 · ● 1 未读'), lines.join('\n'));
});

/** Ids from `ids` that the panel actually rendered, in list order. */
function renderedIds(tree, ids) {
  return ids.filter(id => findBox(tree, id) !== undefined);
}

test('panel: a short panel folds read conversations until the list fits', () => {
  const fixture = manyDoneSnapshot();
  const allIds = fixture.flatRows.map(item => item.id);
  // height 14 leaves 12 body lines. Two project headers take two of them, so
  // each project keeps five of its ten read rows: 2 + 5 + 5 = 12.
  const tree = createHarness(() => fixture, { height: 14 }).render();
  assert.deepEqual(renderedIds(tree, allIds), [
    'p0-done-9', 'p0-done-8', 'p0-done-7', 'p0-done-6', 'p0-done-5',
    'p1-done-9', 'p1-done-8', 'p1-done-7', 'p1-done-6', 'p1-done-5',
  ]);
  assert.ok(findBox(tree, 'g:/repo/p0'), 'the first project header stays');
  assert.ok(findBox(tree, 'g:/repo/p1'), 'the second project header stays');
  // The header counts conversations, not the two project header lines.
  assert.ok(textLines(tree).includes('共 10 个会话'), textLines(tree).join('\n'));
});

test('panel: a taller panel reveals the folded conversations again', () => {
  const fixture = manyDoneSnapshot();
  const allIds = fixture.flatRows.map(item => item.id);
  const tree = createHarness(() => fixture, { height: 30 }).render();
  assert.equal(renderedIds(tree, allIds).length, 20, 'nothing is folded when it fits');
  assert.ok(textLines(tree).includes('共 20 个会话'), textLines(tree).join('\n'));
});

test('panel: folding never hides the attached conversation', () => {
  const fixture = manyDoneSnapshot({ current: 'p0-done-0' });
  const tree = createHarness(() => fixture, { height: 14 }).render();
  assert.ok(findBox(tree, 'p0-done-0'), 'the attached oldest row keeps its slot');
  assert.ok(findBox(tree, 'p0-done-9'), 'the newest rows stay');
  assert.equal(findBox(tree, 'p0-done-5'), undefined, 'the fifth-newest row yields its slot');
});

test('panel: keyboard movement stays inside the folded view', () => {
  const fixture = manyDoneSnapshot();
  const harness = createHarness(() => fixture, { height: 14 });
  harness.render();
  // 51 steps from the attached row: 51 % 10 = 1, so the selection lands on a
  // visible row instead of the attached one (which would only toast).
  for (let index = 0; index < 51; index += 1) harness.press('', { downArrow: true });
  harness.press('', { return: true });
  assert.equal(harness.requests.length, 1);
  const target = harness.requests[0].id;
  const tree = harness.render();
  assert.ok(findBox(tree, target), `the selected row ${target} is rendered`);
  for (const hidden of ['p0-done-4', 'p0-done-0', 'p1-done-4', 'p1-done-0']) {
    assert.notEqual(target, hidden, 'a folded row can never be selected');
  }
});
