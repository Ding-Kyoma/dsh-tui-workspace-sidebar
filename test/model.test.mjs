import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETENTION_MS,
  DONE_ROWS_PER_PROJECT,
  RANK_DONE,
  RANK_RUNNING,
  RANK_UNREAD,
  RUNNING_FRAMES,
  activityAt,
  applyRowState,
  basename,
  buildGroups,
  emptyFold,
  foldAgentEvents,
  formatWhen,
  glyphFor,
  isUnread,
  isVisible,
  nextExpiry,
  normalizeCwd,
  oneLine,
  orderAtOf,
  pruneRows,
  rankOf,
  selectedRow,
  spinnerGlyph,
  windowTop,
} from '../model.js';

const HOUR = 60 * 60 * 1000;

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
  assert.equal(state.turnStartedAt, 0);
});

test('foldAgentEvents: the newest turn start becomes the ordering anchor', () => {
  const { state, count } = foldAgentEvents([
    { type: 'turn/start', time: 100, data: { turn: 1 } },
    { type: 'tool/call', time: 150, data: { name: 'Bash' } },
    { type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 300, data: { turn: 2 } },
  ], 0, emptyFold());
  assert.equal(count, 4);
  assert.equal(state.turnStartedAt, 300);
  assert.equal(state.updatedAt, 300);

  // Incremental folding keeps a checkpoint that predates the anchor field.
  const legacy = foldAgentEvents([
    { type: 'turn/start', time: 400, data: { turn: 3 } },
  ], 0, { count: 0, title: '', prompt: '', summary: '', updatedAt: 0, failed: false });
  assert.equal(legacy.state.turnStartedAt, 400);
});

test('foldAgentEvents: plan mode is last-wins and defaults to off', () => {
  assert.equal(emptyFold().plan, false);

  const first = foldAgentEvents([
    { type: 'plan/mode', time: 10, data: { active: true } },
    { type: 'assistant/message', time: 20, data: { message: { content: [{ type: 'text', text: 'planning' }] } } },
  ], 0, emptyFold());
  assert.equal(first.state.plan, true);

  // A malformed payload is ignored; the last boolean wins.
  const continued = foldAgentEvents([
    { type: 'plan/mode', time: 10, data: { active: true } },
    { type: 'assistant/message', time: 20, data: { message: { content: [{ type: 'text', text: 'planning' }] } } },
    { type: 'plan/mode', time: 30, data: { active: 'yes' } },
    { type: 'plan/mode', time: 40, data: { active: false } },
  ], first.count, first.state);
  assert.equal(continued.state.plan, false);

  // A later checkpoint resumes from the folded selection.
  const reentered = foldAgentEvents([
    { type: 'plan/mode', time: 10, data: { active: true } },
    { type: 'assistant/message', time: 20, data: { message: { content: [{ type: 'text', text: 'planning' }] } } },
    { type: 'plan/mode', time: 30, data: { active: 'yes' } },
    { type: 'plan/mode', time: 40, data: { active: false } },
    { type: 'plan/mode', time: 50, data: { active: true } },
  ], continued.count, continued.state);
  assert.equal(reentered.state.plan, true);
});

test('applyRowState: plan mode is carried while running and cleared on finish', () => {
  const running = applyRowState(undefined, {
    id: 'a', cwd: '/r', title: 't', running: true, plan: true, updatedAt: 10, currentId: '', now: 10,
  });
  assert.equal(running.status, 'running');
  assert.equal(running.plan, true);

  const busy = applyRowState(running, {
    id: 'a', cwd: '/r', title: 't', running: true, plan: false, updatedAt: 20, currentId: '', now: 20,
  });
  assert.equal(busy.plan, false);

  const idle = applyRowState(busy, {
    id: 'a', cwd: '/r', title: 't', running: false, failed: false, updatedAt: 30, currentId: '', now: 30,
  });
  assert.equal(idle.status, 'finished');
  assert.equal(idle.plan, false);
});

test('applyRowState: idle agents never seen running are ignored', () => {
  assert.equal(applyRowState(undefined, { id: 'a', cwd: '/r', title: '', running: false, updatedAt: 0, currentId: '', now: 5 }), undefined);
});

test('applyRowState: the attached session is adopted as a read row', () => {
  const adopted = applyRowState(undefined, {
    id: 'a',
    cwd: '/r',
    title: 't',
    running: false,
    updatedAt: 900,
    currentId: 'a',
    now: 1_000,
  });
  assert.equal(adopted.status, 'finished');
  assert.equal(adopted.finishedAt, 900);
  assert.equal(isUnread(adopted), false);
  assert.equal(adopted.updatedAt, 900);
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

test('applyRowState: in-turn events never move a running row\'s anchor, a new turn does', () => {
  const first = applyRowState(undefined, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 900, turnStartedAt: 900, currentId: '', now: 1_000,
  });
  assert.equal(first.runningAt, 900);

  // A hundred tool calls later the activity time is fresh but the anchor is not.
  const busy = applyRowState(first, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 5_000, turnStartedAt: 900, currentId: '', now: 5_100,
  });
  assert.equal(busy.runningAt, 900, 'the anchor survives in-turn activity');
  assert.equal(busy.updatedAt, 5_000, 'the activity clock still advances');

  const nextTurn = applyRowState(busy, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 6_000, turnStartedAt: 6_000, currentId: '', now: 6_100,
  });
  assert.equal(nextTurn.runningAt, 6_000, 'a new turn anchors the row again');

  // A stale turn marker (fold reset after compaction) never drags the anchor back.
  const stale = applyRowState(nextTurn, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 6_100, turnStartedAt: 500, currentId: '', now: 6_200,
  });
  assert.equal(stale.runningAt, 6_000);

  const done = applyRowState(nextTurn, {
    id: 'a', cwd: '/r', title: 't', running: false, updatedAt: 6_000, currentId: '', now: 7_000,
  });
  assert.equal(done.runningAt, 0);
  assert.equal(done.finishedAt, 7_000);
});

test('applyRowState: without a turn marker the first sighting anchors to its last event', () => {
  const first = applyRowState(undefined, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 700, currentId: '', now: 1_000,
  });
  assert.equal(first.runningAt, 700);
  const later = applyRowState(first, {
    id: 'a', cwd: '/r', title: 't', running: true, updatedAt: 900, currentId: '', now: 1_500,
  });
  assert.equal(later.runningAt, 700, 'later events do not move the anchor');
});

test('buildGroups: lists the current conversation and recent read rows in triage order', () => {
  const registry = [{ path: '/repo/app/', title: 'App' }];
  const rows = [
    row({ id: 'run', status: 'running', finishedAt: 0, updatedAt: 300, title: 'Running', cwd: '/repo/app' }),
    row({ id: 'unread-old', finishedAt: 100, updatedAt: 100, title: 'Old', cwd: '/repo/app' }),
    row({ id: 'unread-new', finishedAt: 200, updatedAt: 200, title: 'New', cwd: '/repo/other' }),
    row({ id: 'read', finishedAt: 50, updatedAt: 50, seenAt: 60, title: 'Read', cwd: '/repo/app' }),
    row({ id: 'current', finishedAt: 400, updatedAt: 400, seenAt: 400, title: 'Current', cwd: '/repo/app' }),
  ];
  const result = buildGroups(rows, registry, 'current', { now: 1_000 });
  assert.equal(result.running, 1);
  // The attached session is visible but never counted as unread.
  assert.equal(result.unread, 2);
  // Unread leads even in the older project; inside a project the classes are
  // unread, then running, then read, each newest-first.
  assert.deepEqual(result.groups.map(group => group.title), ['other', 'App']);
  assert.deepEqual(result.groups[1].rows.map(item => item.id), ['unread-old', 'run', 'current', 'read']);
  assert.deepEqual(result.flatRows.map(item => item.id), ['unread-new', 'unread-old', 'run', 'current', 'read']);
});

test('rankOf: unread finish, then running, then everything already read', () => {
  assert.equal(rankOf(row({ status: 'running', finishedAt: 0, seenAt: 0 })), RANK_RUNNING);
  assert.equal(rankOf(row({ status: 'finished', finishedAt: 10, seenAt: 0 })), RANK_UNREAD);
  assert.equal(rankOf(row({ status: 'finished', finishedAt: 10, seenAt: 10 })), RANK_DONE);
  assert.equal(rankOf(row({ status: 'finished', failed: true, finishedAt: 10, seenAt: 0 })), RANK_UNREAD, 'a failed finish is still unread');
  assert.equal(rankOf(undefined), RANK_DONE);
  assert.equal(rankOf({}), RANK_DONE);
});

test('buildGroups: a class beats recency inside a project', () => {
  const now = 30_000;
  const rows = [
    // The read row is the newest thing that happened, but it still goes last.
    row({ id: 'read-newest', finishedAt: 29_000, updatedAt: 29_000, seenAt: 29_000 }),
    // The running turn started before the unread finish; running still follows unread.
    row({ id: 'running', status: 'running', runningAt: 20_000, finishedAt: 0, updatedAt: 28_000 }),
    // The unread finish is the oldest event of the three, and still leads.
    row({ id: 'unread-oldest', finishedAt: 10_000, updatedAt: 10_000, seenAt: 0 }),
    row({ id: 'unread-newer', finishedAt: 15_000, updatedAt: 15_000, seenAt: 0 }),
  ];
  assert.deepEqual(
    buildGroups(rows, [], '', { now }).flatRows.map(item => item.id),
    ['unread-newer', 'unread-oldest', 'running', 'read-newest'],
  );
});

test('buildGroups: caps already-read conversations at 10 per project', () => {
  const now = 100_000;
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    rows.push(row({
      id: `a-done-${index}`,
      cwd: '/repo/app',
      finishedAt: 1_000 + index,
      updatedAt: 1_000 + index,
      seenAt: 1_000 + index,
    }));
    rows.push(row({
      id: `b-done-${index}`,
      cwd: '/repo/other',
      finishedAt: 2_000 + index,
      updatedAt: 2_000 + index,
      seenAt: 2_000 + index,
    }));
  }
  rows.push(row({ id: 'a-run', cwd: '/repo/app', status: 'running', runningAt: 3_000, finishedAt: 0, updatedAt: 3_000 }));
  rows.push(row({ id: 'a-unread', cwd: '/repo/app', finishedAt: 4_000, updatedAt: 4_000, seenAt: 0 }));
  rows.push(row({ id: 'b-unread', cwd: '/repo/other', finishedAt: 5_000, updatedAt: 5_000, seenAt: 0 }));

  const result = buildGroups(rows, [], '', { now });
  const groupOf = key => result.groups.find(group => group.key === key);
  const doneOf = group => group.rows.filter(item => rankOf(item) === RANK_DONE).map(item => item.id);

  assert.equal(DONE_ROWS_PER_PROJECT, 10);
  // The cap is per project: each one keeps its own newest ten read rows.
  assert.deepEqual(doneOf(groupOf('/repo/app')), [
    'a-done-11', 'a-done-10', 'a-done-9', 'a-done-8', 'a-done-7',
    'a-done-6', 'a-done-5', 'a-done-4', 'a-done-3', 'a-done-2',
  ]);
  assert.deepEqual(doneOf(groupOf('/repo/other')), [
    'b-done-11', 'b-done-10', 'b-done-9', 'b-done-8', 'b-done-7',
    'b-done-6', 'b-done-5', 'b-done-4', 'b-done-3', 'b-done-2',
  ]);
  // Running and unread rows are never part of the cap.
  assert.ok(groupOf('/repo/app').rows.some(item => item.id === 'a-run'));
  assert.ok(groupOf('/repo/app').rows.some(item => item.id === 'a-unread'));
  assert.ok(groupOf('/repo/other').rows.some(item => item.id === 'b-unread'));
  assert.equal(result.running, 1);
  assert.equal(result.unread, 2);
  // 20 kept read rows + 1 running + 2 unread, so the panel total may exceed 10.
  assert.equal(result.flatRows.length, 23);
});

test('buildGroups: the attached read conversation keeps a slot inside the cap', () => {
  const now = 100_000;
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    rows.push(row({
      id: `done-${index}`,
      finishedAt: 1_000 + index,
      updatedAt: 1_000 + index,
      seenAt: 1_000 + index,
    }));
  }
  const result = buildGroups(rows, [], 'done-0', { now });
  const ids = result.groups[0].rows.map(item => item.id);
  assert.equal(ids.filter(id => id.startsWith('done-')).length, 10);
  assert.ok(ids.includes('done-0'), 'the attached conversation is never capped away');
  assert.ok(!ids.includes('done-2'), 'the oldest kept row yields its slot');
  assert.equal(selectedRow(result.flatRows, null, 'done-0').id, 'done-0');
});

test('buildGroups: projects follow the same class priority', () => {
  const now = 30_000;
  const rows = [
    row({ id: 'read', cwd: '/repo/done', finishedAt: 29_000, updatedAt: 29_000, seenAt: 29_000 }),
    row({ id: 'running', cwd: '/repo/busy', status: 'running', runningAt: 28_000, finishedAt: 0, updatedAt: 28_000 }),
    row({ id: 'unread', cwd: '/repo/waiting', finishedAt: 10_000, updatedAt: 10_000, seenAt: 0 }),
  ];
  assert.deepEqual(buildGroups(rows, [], '', { now }).groups.map(group => group.title), ['waiting', 'busy', 'done']);
});

test('buildGroups: concurrent running rows keep their order while their activity moves', () => {
  const registry = [{ path: '/repo/app' }];
  const now = 10_000;
  const a = row({ id: 'a', status: 'running', runningAt: 1_000, finishedAt: 0, updatedAt: 1_000 });
  const b = row({ id: 'b', status: 'running', runningAt: 2_000, finishedAt: 0, updatedAt: 2_000 });

  // The newest turn is on top, and stays there no matter who logs next.
  assert.deepEqual(buildGroups([a, b], registry, '', { now }).flatRows.map(item => item.id), ['b', 'a']);
  a.updatedAt = 9_500;
  assert.deepEqual(buildGroups([a, b], registry, '', { now }).flatRows.map(item => item.id), ['b', 'a']);
  b.updatedAt = 9_700;
  assert.deepEqual(buildGroups([a, b], registry, '', { now }).flatRows.map(item => item.id), ['b', 'a']);

  // A new turn does move the row, once.
  a.runningAt = 9_800;
  assert.deepEqual(buildGroups([a, b], registry, '', { now }).flatRows.map(item => item.id), ['a', 'b']);
});

test('buildGroups: a finished row is anchored to its finish, not to later events', () => {
  const done = row({ id: 'done', finishedAt: 1_000, updatedAt: 1_000 });
  const other = row({ id: 'other', finishedAt: 2_000, updatedAt: 2_000 });
  done.updatedAt = 5_000; // a late session/title (or job) event
  assert.deepEqual(buildGroups([done, other], [], '', { now: 10_000 }).flatRows.map(item => item.id), ['other', 'done']);
});

test('buildGroups: projects with running conversations keep a stable order', () => {
  const now = 10_000;
  const a = row({ id: 'a', cwd: '/repo/one', status: 'running', runningAt: 1_000, finishedAt: 0, updatedAt: 1_000 });
  const b = row({ id: 'b', cwd: '/repo/two', status: 'running', runningAt: 2_000, finishedAt: 0, updatedAt: 2_000 });
  assert.deepEqual(buildGroups([a, b], [], '', { now }).groups.map(group => group.title), ['two', 'one']);
  a.updatedAt = 9_000; // churn inside project one's turn
  assert.deepEqual(buildGroups([a, b], [], '', { now }).groups.map(group => group.title), ['two', 'one']);
});

test('buildGroups: an exact anchor tie falls back to the session id', () => {
  const now = 10_000;
  const rows = [
    row({ id: 'b', cwd: '/repo/app', status: 'running', runningAt: 2_000, finishedAt: 0, updatedAt: 2_000 }),
    row({ id: 'a', cwd: '/repo/app', status: 'running', runningAt: 2_000, finishedAt: 0, updatedAt: 2_000 }),
  ];
  assert.deepEqual(buildGroups(rows, [], '', { now }).flatRows.map(item => item.id), ['a', 'b']);
});

test('buildGroups: falls back to basename and keeps unknown directories together', () => {
  const result = buildGroups([
    row({ id: 'a', cwd: '', finishedAt: 100 }),
    row({ id: 'b', cwd: '/x/y', finishedAt: 90 }),
  ], [], '', { now: 1_000 });
  assert.equal(result.groups.length, 2);
  assert.deepEqual(new Set(result.groups.map(group => group.title)), new Set(['', 'y']));
});

test('isVisible: running and attached rows stay, finished rows follow the retention window', () => {
  const now = 10 * HOUR;
  assert.equal(isVisible(row({ status: 'running', finishedAt: 0, updatedAt: now }), { now }), true);
  assert.equal(isVisible(row({ id: 'a', updatedAt: now - HOUR, finishedAt: now - HOUR }), { now }), true);
  assert.equal(isVisible(row({ id: 'a', updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR }), { now }), false);
  assert.equal(
    isVisible(row({ id: 'a', updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR }), { now, currentId: 'a' }),
    true,
    'the attached session is pinned even past the window',
  );
  // A zero window restores the old rule: only unread rows survive.
  assert.equal(isVisible(row({ id: 'a', updatedAt: now - HOUR, finishedAt: now - HOUR, seenAt: now }), { now, retentionMs: 0 }), false);
  assert.equal(isVisible(row({ id: 'a', updatedAt: now - HOUR, finishedAt: now - HOUR }), { now, retentionMs: 0 }), true);
});

test('buildGroups: hides expired rows, keeps the current one, and honours a zero window', () => {
  const now = 10 * HOUR;
  const rows = [
    row({ id: 'old-read', updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR, seenAt: now - 7 * HOUR }),
    row({ id: 'old-unread', updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR }),
    row({ id: 'recent', updatedAt: now - HOUR, finishedAt: now - HOUR, seenAt: now - HOUR }),
    row({ id: 'current', updatedAt: now - 30 * HOUR, finishedAt: now - 30 * HOUR, seenAt: now - 30 * HOUR }),
  ];
  const kept = buildGroups(rows, [], 'current', { now });
  assert.deepEqual(kept.flatRows.map(item => item.id), ['recent', 'current']);
  assert.equal(kept.unread, 0);

  const legacy = buildGroups(rows, [], '', { now, retentionMs: 0 });
  assert.deepEqual(legacy.flatRows.map(item => item.id), ['old-unread']);
});

test('activityAt: the later of the last event and the finish marker', () => {
  assert.equal(activityAt(row({ updatedAt: 100, finishedAt: 200 })), 200);
  assert.equal(activityAt(row({ updatedAt: 300, finishedAt: 200 })), 300);
  assert.equal(activityAt(undefined), 0);
});

test('orderAtOf: running rows use the turn anchor, finished rows the finish marker', () => {
  assert.equal(orderAtOf(row({ status: 'running', runningAt: 500, updatedAt: 9_000, finishedAt: 0 })), 500);
  assert.equal(orderAtOf(row({ status: 'finished', finishedAt: 1_000, updatedAt: 9_000 })), 1_000);
  // Rows without an anchor (restored from disk, hand-built) fall back to activity.
  assert.equal(orderAtOf(row({ status: 'running', updatedAt: 9_000, finishedAt: 0 })), 9_000);
  assert.equal(orderAtOf(row({ status: 'finished', finishedAt: 0, updatedAt: 9_000 })), 9_000);
  assert.equal(orderAtOf(undefined), 0);
  assert.equal(orderAtOf({}), 0);
});

test('pruneRows: sweeps expired rows, pins the attached one, and respects the cap', () => {
  const now = 30 * HOUR;
  const rows = new Map();
  rows.set('expired', row({ id: 'expired', updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR, seenAt: now - 6 * HOUR }));
  rows.set('read', row({ id: 'read', updatedAt: now - HOUR, finishedAt: now - HOUR, seenAt: now - HOUR }));
  rows.set('current', row({ id: 'current', updatedAt: now - 10 * HOUR, finishedAt: now - 10 * HOUR, seenAt: now - 10 * HOUR }));
  rows.set('live', row({ id: 'live', status: 'running', finishedAt: 0, updatedAt: now }));
  pruneRows(rows, 10, now, { currentId: 'current' });
  assert.equal(rows.has('expired'), false);
  assert.equal(rows.has('read'), true);
  assert.equal(rows.has('current'), true);
  assert.equal(rows.has('live'), true);

  const capped = new Map();
  capped.set('a', row({ id: 'a', updatedAt: now - 5 * HOUR, finishedAt: now - 5 * HOUR }));
  capped.set('b', row({ id: 'b', updatedAt: now - 4 * HOUR, finishedAt: now - 4 * HOUR }));
  capped.set('current', row({ id: 'current', updatedAt: now - 9 * HOUR, finishedAt: now - 9 * HOUR }));
  pruneRows(capped, 2, now, { currentId: 'current' });
  assert.equal(capped.has('a'), false);
  assert.equal(capped.has('b'), true);
  assert.equal(capped.has('current'), true);
  assert.equal(capped.size, 2);
});

test('nextExpiry: the earliest retained finish, ignoring running and attached rows', () => {
  const now = 100 * HOUR;
  const rows = new Map([
    ['run', row({ id: 'run', status: 'running', finishedAt: 0, updatedAt: now })],
    ['current', row({ id: 'current', updatedAt: now - 5 * HOUR, finishedAt: now - 5 * HOUR })],
    ['fresh', row({ id: 'fresh', updatedAt: now - HOUR, finishedAt: now - HOUR })],
    ['older', row({ id: 'older', updatedAt: now - 2 * HOUR, finishedAt: now - 2 * HOUR })],
  ]);
  // The least recently active row is the first to expire.
  assert.equal(nextExpiry(rows, DEFAULT_RETENTION_MS, 'current'), now - 2 * HOUR + DEFAULT_RETENTION_MS);
  assert.equal(nextExpiry(new Map(), DEFAULT_RETENTION_MS, ''), 0);
});

test('selectedRow: explicit choice, then the attached conversation, then the first row', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
  assert.equal(selectedRow(rows, 'b', 'c').id, 'b');
  assert.equal(selectedRow(rows, null, 'c').id, 'c');
  assert.equal(selectedRow(rows, 'gone', 'c').id, 'c');
  assert.equal(selectedRow(rows, 'gone', '').id, 'a');
  assert.equal(selectedRow([], null, 'a'), undefined);
});

test('glyphFor: spinner for running, dot for unread, dim check once read, cross for failure', () => {
  assert.equal(glyphFor(row({ status: 'running' }), 3).char, RUNNING_FRAMES[3]);
  assert.deepEqual(glyphFor(row(), 0), { char: '●', color: 'success', dim: false });
  assert.deepEqual(glyphFor(row({ seenAt: 2_000 }), 0), { char: '✓', color: 'success', dim: true });
  assert.deepEqual(glyphFor(row({ failed: true }), 0), { char: '✕', color: 'error', dim: false });
  assert.deepEqual(glyphFor(row({ failed: true, seenAt: 2_000 }), 0), { char: '✕', color: 'error', dim: true });
});

test('glyphFor: a running plan-mode row spins in the plan colour', () => {
  assert.deepEqual(glyphFor(row({ status: 'running', plan: true }), 0), {
    char: RUNNING_FRAMES[0],
    color: 'planMode',
    dim: false,
  });
  assert.deepEqual(glyphFor(row({ status: 'running', plan: false }), 0), {
    char: RUNNING_FRAMES[0],
    color: 'suggestion',
    dim: false,
  });
  // A finished row never keeps the plan colour, even if a stale flag lingers.
  assert.equal(glyphFor(row({ plan: true }), 0).color, 'success');
});

test('spinnerGlyph: every running count shares one frame and junk settles on the first', () => {
  assert.equal(spinnerGlyph(0), RUNNING_FRAMES[0]);
  assert.equal(spinnerGlyph(5), RUNNING_FRAMES[5]);
  assert.equal(spinnerGlyph(RUNNING_FRAMES.length), RUNNING_FRAMES[0]);
  assert.equal(spinnerGlyph(-1), RUNNING_FRAMES[1]);
  assert.equal(spinnerGlyph(Number.NaN), RUNNING_FRAMES[0]);
  assert.equal(spinnerGlyph(Number.POSITIVE_INFINITY), RUNNING_FRAMES[0]);
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
