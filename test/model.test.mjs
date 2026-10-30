import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNNING_FRAMES,
  applyRowState,
  basename,
  buildGroups,
  emptyFold,
  foldAgentEvents,
  formatWhen,
  glyphFor,
  isUnread,
  normalizeCwd,
  oneLine,
  pruneRows,
  windowTop,
} from '../model.js';

function row(overrides = {}) {
  return {
    id: 's1',
    cwd: '/repo/app',
    title: 'Fix login',
    status: 'finished',
    failed: false,
    updatedAt: 1_000,
    finishedAt: 1_000,
    seenAt: 0,
    ...overrides,
  };
}

test('foldAgentEvents: title, first human prompt, summary, failure, activity time', () => {
  const events = [
    { type: 'user/message', time: 100, data: { source: { kind: 'injection' }, content: [{ type: 'text', text: 'injected' }] } },
    { type: 'user/message', time: 110, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first question' }] } },
    { type: 'user/message', time: 120, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] } },
    { type: 'session/title', time: 130, data: { title: '  A\nnice\t title ' } },
    { type: 'tool/call', time: 140, data: { name: 'Bash' } },
    { type: 'assistant/message', time: 150, data: { message: { content: [{ type: 'text', text: 'All done' }] } } },
    { type: 'turn/end', time: 160, data: { reason: { kind: 'completed' } } },
  ];
  const { state, count } = foldAgentEvents(events, 0, emptyFold());
  assert.equal(count, 7);
  assert.equal(state.prompt, 'first question');
  assert.equal(state.title, 'A nice title');
  assert.equal(state.summary, 'All done');
  assert.equal(state.updatedAt, 160);
  assert.equal(state.failed, false);
});

test('foldAgentEvents: increments from a checkpoint and detects an error turn', () => {
  const first = foldAgentEvents([
    { type: 'user/message', time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  ], 0, emptyFold());
  const second = foldAgentEvents([
    { type: 'user/message', time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    { type: 'turn/end', time: 200, data: { reason: { kind: 'error' } } },
  ], first.count, first.state);
  assert.equal(second.count, 2);
  assert.equal(second.state.failed, true);
  assert.equal(second.state.prompt, 'hi');
});

test('foldAgentEvents tolerates junk events', () => {
  const { state, count } = foldAgentEvents([null, 42, { type: 'other', data: 'x' }], 0, emptyFold());
  assert.equal(count, 3);
  assert.equal(state.prompt, '');
  assert.equal(state.failed, false);
});

test('applyRowState: idle agents never seen running are ignored', () => {
  assert.equal(applyRowState(undefined, { id: 'a', cwd: '/r', title: '', running: false, updatedAt: 0, currentId: '', now: 5 }), undefined);
});

test('applyRowState: running -> idle becomes unread; a current session settles as read', () => {
  const running = applyRowState(undefined, { id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 10, currentId: '', now: 10 });
  assert.equal(running.status, 'running');
  assert.equal(running.finishedAt, 0);

  const idle = applyRowState(running, { id: 'a', cwd: '/r', title: 't', running: false, failed: false, updatedAt: 20, currentId: '', now: 20 });
  assert.equal(idle.status, 'finished');
  assert.equal(idle.finishedAt, 20);
  assert.equal(idle.seenAt, 0);
  assert.equal(isUnread(idle), true);

  const current = applyRowState(running, { id: 'a', cwd: '/r', title: 't', running: false, failed: false, updatedAt: 20, currentId: 'a', now: 20 });
  assert.equal(isUnread(current), false);
});

test('applyRowState: finished-unread keeps its timestamp, but becomes read when current', () => {
  const unread = row({ finishedAt: 1_000, seenAt: 0 });
  const kept = applyRowState(unread, { id: 's1', cwd: '/repo/app', title: 'Fix login', running: false, failed: false, updatedAt: 900, currentId: '', now: 2_000 });
  assert.equal(kept.finishedAt, 1_000);
  assert.equal(isUnread(kept), true);

  const seen = applyRowState(unread, { id: 's1', cwd: '/repo/app', title: 'Fix login', running: false, failed: false, updatedAt: 900, currentId: 's1', now: 2_000 });
  assert.equal(isUnread(seen), false);
});

test('applyRowState: a new turn resets the finish marker and can be unread again', () => {
  const unread = row({ finishedAt: 1_000, seenAt: 0 });
  const running = applyRowState(unread, { id: 's1', cwd: '/repo/app', title: 'Fix login', running: true, updatedAt: 1_500, currentId: '', now: 1_500 });
  assert.equal(running.status, 'running');
  assert.equal(running.finishedAt, 0);
  const again = applyRowState(running, { id: 's1', cwd: '/repo/app', title: 'Fix login', running: false, failed: true, updatedAt: 1_600, currentId: '', now: 1_600 });
  assert.equal(isUnread(again), true);
  assert.equal(again.failed, true);
});

test('buildGroups: filters, groups, sorts, and hides the current session', () => {
  const registry = [{ path: '/repo/app/', title: 'App' }];
  const rows = [
    row({ id: 'run', status: 'running', finishedAt: 0, updatedAt: 300, title: 'Running', cwd: '/repo/app' }),
    row({ id: 'unread-old', finishedAt: 100, updatedAt: 100, title: 'Old', cwd: '/repo/app' }),
    row({ id: 'unread-new', finishedAt: 200, updatedAt: 200, title: 'New', cwd: '/repo/other' }),
    row({ id: 'read', finishedAt: 50, updatedAt: 50, seenAt: 60, title: 'Read', cwd: '/repo/app' }),
    row({ id: 'current', finishedAt: 400, updatedAt: 400, title: 'Current', cwd: '/repo/app' }),
  ];
  const result = buildGroups(rows, registry, 'current');
  assert.equal(result.running, 1);
  assert.equal(result.unread, 2);
  assert.deepEqual(result.groups.map(group => group.title), ['App', 'other']);
  assert.deepEqual(result.groups[0].rows.map(item => item.id), ['run', 'unread-old']);
  assert.deepEqual(result.flatRows.map(item => item.id), ['run', 'unread-old', 'unread-new']);
});

test('buildGroups: falls back to basename and keeps unknown directories together', () => {
  const result = buildGroups([
    row({ id: 'a', cwd: '', finishedAt: 100 }),
    row({ id: 'b', cwd: '/x/y', finishedAt: 90 }),
  ], [], '');
  assert.equal(result.groups.length, 2);
  assert.deepEqual(new Set(result.groups.map(group => group.title)), new Set(['', 'y']));
});

test('pruneRows: drops old finished rows and respects the cap', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 30 * day;
  const rows = new Map();
  rows.set('old', row({ id: 'old', finishedAt: now - 20 * day }));
  rows.set('a', row({ id: 'a', finishedAt: now - 2 * day }));
  rows.set('b', row({ id: 'b', finishedAt: now - day }));
  rows.set('live', row({ id: 'live', status: 'running', finishedAt: 0 }));
  pruneRows(rows, 3, now);
  assert.equal(rows.has('old'), false);
  assert.equal(rows.has('live'), true);
  assert.equal(rows.size, 3);
  pruneRows(rows, 2, now);
  assert.equal(rows.size, 2);
  assert.equal(rows.has('a'), false);
});

test('glyphFor: spinner for running, check for unread, cross for failed', () => {
  assert.equal(glyphFor(row({ status: 'running' }), 3).char, RUNNING_FRAMES[3]);
  assert.equal(glyphFor(row(), 0).char, '✓');
  assert.equal(glyphFor(row({ failed: true }), 0).char, '✕');
});

test('formatWhen: relative labels and a clock-safe fallback', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.equal(formatWhen(now - 10_000, now, 'zh'), '刚刚');
  assert.equal(formatWhen(now - 5 * 60_000, now, 'en'), '5m ago');
  assert.equal(formatWhen(now - 3 * 3_600_000, now, 'zh'), '3 小时前');
  assert.equal(formatWhen(0, now, 'en'), '');
});

test('windowTop keeps the focus visible', () => {
  assert.equal(windowTop(10, 0, 5), 0);
  assert.equal(windowTop(10, 9, 5), 5);
  assert.equal(windowTop(10, 5, 5), 3);
  assert.equal(windowTop(3, 1, 5), 0);
});

test('path helpers normalize separators and collapse one-line text', () => {
  assert.equal(normalizeCwd('/a/b///'), '/a/b');
  assert.equal(basename('/a/b'), 'b');
  assert.equal(basename(''), '');
  assert.equal(oneLine('a\n\n b\tc', 40), 'a b c');
  assert.equal(oneLine('x'.repeat(10), 5), 'xxxx…');
});
