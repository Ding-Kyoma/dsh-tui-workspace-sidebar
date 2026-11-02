import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../tracker.js';
import { DONE_ROWS_PER_PROJECT } from '../model.js';

function makeAgent({ id, status = 'idle', cwd = '/repo/app', origin = 'user', events = [] }) {
  return {
    id,
    status,
    session: {
      header: { id, cwd, origin },
      snapshotEvents: () => events,
    },
  };
}

function makeCtx({ getAgents } = {}) {
  const listeners = new Map();
  let agents = getAgents;
  const ctx = {
    logger: { warn() {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(name, fallback) {
      if (name === 'agents') return agents ?? fallback;
      return fallback;
    },
    inject() {},
  };
  return {
    ctx,
    emit(name, payload) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(payload);
    },
    setAgents(next) {
      agents = next;
    },
  };
}

function makeStore(initial = {}) {
  let state = { version: 1, sessions: initial };
  const saves = [];
  return {
    ready: async () => state,
    snapshot: () => state,
    save(sessions) {
      saves.push(sessions);
      state = { version: 1, sessions };
    },
    close: async () => {},
    saves,
  };
}

function promptEvent(text, time = 100) {
  return { type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } };
}

function turnStart(time) {
  return { type: 'turn/start', time, data: { turn: 1 } };
}

function planEvent(active, time = 100) {
  return { type: 'plan/mode', time, data: { active } };
}

function makeTracker({ agents = [], store = makeStore(), clock = () => 1_000, probe, retentionMs } = {}) {
  const harness = makeCtx({ getAgents: { list: () => agents } });
  const tracker = createTracker({ ctx: harness.ctx, store, logger: { warn() {} }, now: clock, probe, retentionMs });
  tracker.attach();
  return { tracker, harness, store };
}

test('attach seeds a running agent with its title', () => {
  const agent = makeAgent({
    id: 'a',
    status: 'running',
    events: [promptEvent('fix it'), { type: 'session/title', time: 110, data: { title: 'Fix login' } }],
  });
  const { tracker } = makeTracker({ agents: [agent] });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.agentsAvailable, true);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.groups[0].title, 'app');
  assert.equal(snapshot.groups[0].rows[0].title, 'Fix login');
  assert.equal(snapshot.groups[0].rows[0].status, 'running');
});

test('a running plan-mode agent is flagged, and flipping the selection updates the row', () => {
  const events = [promptEvent('plan it', 100), turnStart(100), planEvent(true, 110)];
  const planAgent = makeAgent({ id: 'plan', status: 'running', events });
  const plainAgent = makeAgent({ id: 'plain', status: 'running', events: [promptEvent('do it', 100), turnStart(100)] });
  const { tracker, harness } = makeTracker({ agents: [planAgent, plainAgent] });

  const rowOf = id => tracker.getSnapshot().flatRows.find(row => row.id === id);
  assert.equal(rowOf('plan').plan, true);
  assert.equal(rowOf('plain').plan, false);
  const version = tracker.getVersion();

  events.push(planEvent(false, 120));
  assert.equal(tracker.reconcile(), true);
  assert.equal(rowOf('plan').plan, false);
  assert.ok(tracker.getVersion() > version, 'the flag flip re-renders the panel');

  // Leaving plan mode and finishing settles the row as a normal finish.
  planAgent.status = 'idle';
  harness.emit('agent/status', { agent: planAgent, status: 'idle' });
  assert.equal(rowOf('plan').status, 'finished');
  assert.equal(rowOf('plan').plan, false);
});

test('two running sessions keep a stable order while their logs advance', () => {
  let clock = 10_000;
  const eventsA = [promptEvent('fix a', 100), turnStart(100)];
  const eventsB = [promptEvent('fix b', 200), turnStart(200)];
  const a = makeAgent({ id: 'a', status: 'running', events: eventsA });
  const b = makeAgent({ id: 'b', status: 'running', events: eventsB });
  const { tracker, harness } = makeTracker({ agents: [a, b], clock: () => clock });

  const order = () => tracker.getSnapshot().flatRows.map(row => row.id);
  assert.deepEqual(order(), ['b', 'a']);

  // Hundreds of in-turn events land; neither row is allowed to move.
  for (let index = 0; index < 5; index += 1) {
    clock += 1_000;
    eventsA.push({ type: 'tool/call', time: clock, data: { name: 'Bash' } });
    harness.emit('agent/status', { agent: a, status: 'running' });
    assert.deepEqual(order(), ['b', 'a'], 'a new event in A must not lift A');
    eventsB.push({ type: 'assistant/message', time: clock, data: {} });
    harness.emit('agent/status', { agent: b, status: 'running' });
    assert.deepEqual(order(), ['b', 'a'], 'a new event in B must not lift B');
  }

  // A genuinely new turn in A re-anchors it, once.
  clock += 1_000;
  eventsA.push(turnStart(clock));
  harness.emit('agent/status', { agent: a, status: 'running' });
  assert.deepEqual(order(), ['a', 'b']);
  eventsA.push({ type: 'tool/call', time: clock + 1, data: { name: 'Bash' } });
  clock += 10;
  harness.emit('agent/status', { agent: a, status: 'running' });
  assert.deepEqual(order(), ['a', 'b'], 'the new turn stays anchored');
});

test('a new turn lifts its workspace to the front of its class', () => {
  let clock = 10_000;
  const eventsA = [promptEvent('fix a', 100), turnStart(100)];
  const eventsB = [promptEvent('fix b', 200), turnStart(200)];
  const a = makeAgent({ id: 'a', status: 'running', cwd: '/repo/one', events: eventsA });
  const b = makeAgent({ id: 'b', status: 'running', cwd: '/repo/two', events: eventsB });
  const { tracker, harness } = makeTracker({ agents: [a, b], clock: () => clock });

  const groups = () => tracker.getSnapshot().groups.map(group => group.title);
  // The newer turn leads, whatever the tracker's map order is.
  assert.deepEqual(groups(), ['two', 'one']);

  for (let index = 0; index < 3; index += 1) {
    clock += 1_000;
    eventsA.push(turnStart(clock));
    harness.emit('agent/status', { agent: a, status: 'running' });
    assert.deepEqual(groups(), ['one', 'two'], 'a new turn in one workspace lifts it');

    clock += 1_000;
    eventsB.push(turnStart(clock));
    harness.emit('agent/status', { agent: b, status: 'running' });
    assert.deepEqual(groups(), ['two', 'one'], 'a new turn in the other workspace takes the lead back');

    // In-turn activity never reshuffles the workspaces.
    clock += 1;
    eventsA.push({ type: 'tool/call', time: clock, data: { name: 'Bash' } });
    harness.emit('agent/status', { agent: a, status: 'running' });
    assert.deepEqual(groups(), ['two', 'one'], 'in-turn activity must not lift a workspace');
  }
});

test('a running row is anchored to the turn in its log, not to activation time', () => {
  const agent = makeAgent({
    id: 'a',
    status: 'running',
    events: [promptEvent('fix it', 5_000), turnStart(5_000)],
  });
  const { tracker } = makeTracker({ agents: [agent], clock: () => 100_000 });
  assert.equal(tracker.getSnapshot().flatRows[0].runningAt, 5_000);
});

test('finishing a turn anchors the row to its finish marker', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it', 100), turnStart(100)] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock });
  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  const row = tracker.getSnapshot().flatRows[0];
  assert.equal(row.status, 'finished');
  assert.equal(row.finishedAt, 2_000);
  assert.equal(row.runningAt, 0);
});

test('triage order: an unread finish leads a running session, and trails once read', () => {
  let clock = 1_000;
  const a = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix a', 100), turnStart(100)] });
  const b = makeAgent({ id: 'b', status: 'running', events: [promptEvent('fix b', 200), turnStart(200)] });
  const { tracker, harness } = makeTracker({ agents: [a, b], clock: () => clock });

  // Both running: the newer turn is on top.
  assert.deepEqual(tracker.getSnapshot().flatRows.map(row => row.id), ['b', 'a']);

  // B finishes unread while A keeps running: the unread row leads.
  clock = 2_000;
  b.status = 'idle';
  harness.emit('agent/status', { agent: b, status: 'idle' });
  assert.equal(tracker.getSnapshot().unread, 1);
  assert.deepEqual(tracker.getSnapshot().flatRows.map(row => row.id), ['b', 'a']);

  // Reading B drops it into the trailing class: running A leads now.
  tracker.markSeen('b');
  assert.deepEqual(tracker.getSnapshot().flatRows.map(row => row.id), ['a', 'b']);
});

test('running -> idle becomes finished-unread and is persisted', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness, store } = makeTracker({ agents: [agent], clock: () => clock });
  assert.equal(tracker.getSnapshot().running, 1);

  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.unread, 1);
  assert.equal(snapshot.groups[0].rows[0].finishedAt, 2_000);
  assert.equal(store.saves.length, 2);
  assert.equal(store.saves.at(-1).a.status, 'finished');
});

test('a session that is current when it finishes settles as read but stays listed', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock });
  tracker.setCurrent('a');
  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a']);
  assert.equal(snapshot.flatRows[0].status, 'finished');
  assert.equal(snapshot.flatRows[0].seenAt, 2_000);
});

test('a finished row becomes read when its session becomes current, and is kept', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock });
  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(tracker.getSnapshot().unread, 1);

  tracker.setCurrent('a');
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a']);
  assert.equal(snapshot.flatRows[0].status, 'finished');
  assert.ok(snapshot.flatRows[0].seenAt >= 2_000);
});

test('subagents and never-prompted idle sessions are not tracked', () => {
  const sub = makeAgent({ id: 'sub', status: 'running', origin: 'subagent', events: [promptEvent('x')] });
  const empty = makeAgent({ id: 'empty', status: 'idle', events: [] });
  const { tracker } = makeTracker({ agents: [sub, empty] });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.groups.length, 0);
  assert.equal(snapshot.rows?.length ?? 0, 0);
});

test('markSeen settles a finished row as read and keeps it in the list', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock });
  tracker.markSeen('a');
  assert.equal(tracker.getSnapshot().running, 1);

  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(tracker.getSnapshot().unread, 1);

  tracker.markSeen('a');
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a']);
  assert.equal(snapshot.flatRows[0].status, 'finished');
  assert.ok(snapshot.flatRows[0].seenAt >= 2_000);
});

test('a disposed agent that was running finishes as unread', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent] });
  harness.emit('agent/disposed', { agent });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.unread, 1);
});

test('load restores recent finished rows, drops stale running and expired rows', async () => {
  const HOUR = 60 * 60 * 1000;
  const now = 20 * HOUR;
  const store = makeStore({
    a: { id: 'a', cwd: '/repo/app', title: 'A', status: 'finished', failed: false, updatedAt: now - 60_000, finishedAt: now - 60_000, seenAt: 0 },
    b: { id: 'b', cwd: '/repo/app', title: 'B', status: 'running', failed: false, updatedAt: now - 60_000, finishedAt: 0, seenAt: 0 },
    c: { id: 'c', cwd: '/repo/app', title: 'C', status: 'finished', failed: false, updatedAt: now - HOUR, finishedAt: now - HOUR, seenAt: now - HOUR + 1 },
    d: { id: 'd', cwd: '/repo/app', title: 'D', status: 'finished', failed: false, updatedAt: now - 7 * HOUR, finishedAt: now - 7 * HOUR, seenAt: 0 },
  });
  const { tracker } = makeTracker({ agents: [], store, clock: () => now, retentionMs: 6 * HOUR });
  await tracker.load();
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 1);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a', 'c']);
});

test('the default retention window keeps a finished row from six days ago', async () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * 24 * HOUR;
  const previous = (id, age) => ({
    id,
    cwd: '/repo/app',
    title: id,
    status: 'finished',
    failed: false,
    updatedAt: now - age,
    finishedAt: now - age,
    seenAt: 0,
  });
  const store = makeStore({
    recent: previous('recent', 6 * 24 * HOUR),
    stale: previous('stale', 8 * 24 * HOUR),
  });
  const { tracker } = makeTracker({ agents: [], store, clock: () => now });
  await tracker.load();
  const snapshot = tracker.getSnapshot();
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['recent']);
});

test('load settles a persisted unread row for the attached session as read', async () => {
  const now = 5_000;
  const store = makeStore({
    a: { id: 'a', cwd: '/repo/app', title: 'A', status: 'finished', failed: false, updatedAt: now - 1_000, finishedAt: now - 1_000, seenAt: 0 },
  });
  const { tracker } = makeTracker({ agents: [], store, clock: () => now });
  tracker.setCurrent('a');
  await tracker.load();
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a']);
  assert.ok(snapshot.flatRows[0].seenAt >= now - 1_000);
});

test('reconcile sweeps a finished row once the retention window closes', () => {
  const HOUR = 60 * 60 * 1000;
  let clock = 10 * HOUR;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock, retentionMs: 6 * HOUR });
  clock = 11 * HOUR;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(tracker.getSnapshot().unread, 1);

  clock = 17 * HOUR + 1;
  tracker.reconcile();
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.equal(snapshot.flatRows.length, 0);
});

test('the attached idle session is adopted and listed as read', () => {
  const agent = makeAgent({
    id: 'a',
    status: 'idle',
    events: [promptEvent('fix it'), { type: 'session/title', time: 110, data: { title: 'Fix login' } }],
  });
  const { tracker } = makeTracker({ agents: [agent], clock: () => 1_000, probe: () => 'a' });
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.currentId, 'a');
  assert.equal(snapshot.unread, 0);
  assert.deepEqual(snapshot.flatRows.map(row => row.id), ['a']);
  assert.equal(snapshot.flatRows[0].title, 'Fix login');
  assert.equal(snapshot.flatRows[0].status, 'finished');
});

test('badge counts unread while hidden and clears when visible', async () => {
  const calls = [];
  const panels = { badge: (id, badge) => { calls.push({ id, badge }); return true; } };
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock });
  tracker.setPanelHandle(panels, 'session:act1:inbox');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].badge, null);

  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.deepEqual(calls.at(-1).badge, { level: 'info', unread: 1 });

  tracker.setPanelVisible(true);
  assert.equal(calls.at(-1).badge, null);
});

test('workspace registry titles are used for groups', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const harness = makeCtx({ getAgents: { list: () => [agent] } });
  const workspaces = { listRegistry: () => [{ path: '/repo/app', title: 'My Project' }] };
  const ctx = {
    ...harness.ctx,
    get(name, fallback) {
      if (name === 'tuiWorkspaces') return workspaces;
      return harness.ctx.get(name, fallback);
    },
  };
  const tracker = createTracker({ ctx, store: makeStore(), logger: { warn() {} }, now: () => clock });
  tracker.attach();
  tracker.refreshWorkspaces();
  assert.equal(tracker.getSnapshot().groups[0].title, 'My Project');
});

test('a missing agents service degrades without throwing', () => {
  const harness = makeCtx({ getAgents: undefined });
  const tracker = createTracker({ ctx: harness.ctx, store: makeStore(), logger: { warn() {} } });
  assert.doesNotThrow(() => tracker.attach());
  assert.equal(tracker.getSnapshot().agentsAvailable, false);
  assert.equal(tracker.getSnapshot().groups.length, 0);
  assert.doesNotThrow(() => tracker.reconcile());
});

test('the attached-session probe overrides the panel-reported current id', () => {
  let clock = 1_000;
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent], clock: () => clock, probe: () => 'a' });
  assert.equal(tracker.getSnapshot().currentId, 'a');
  clock = 2_000;
  agent.status = 'idle';
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(tracker.getSnapshot().unread, 0);
});

test('the per-project display cap never prunes persisted read rows', async () => {
  const now = 100_000;
  const persisted = {};
  for (let index = 0; index < DONE_ROWS_PER_PROJECT + 2; index += 1) {
    const at = now - index * 1_000;
    persisted[`r${index}`] = {
      id: `r${index}`,
      cwd: '/repo/app',
      title: `R${index}`,
      status: 'finished',
      failed: false,
      updatedAt: at,
      finishedAt: at,
      seenAt: at,
    };
  }
  const store = makeStore(persisted);
  const { tracker } = makeTracker({ agents: [], store, clock: () => now });
  await tracker.load();
  const snapshot = tracker.getSnapshot();
  assert.equal(DONE_ROWS_PER_PROJECT, 10);
  assert.equal(snapshot.groups[0].rows.length, DONE_ROWS_PER_PROJECT);
  // The cap is display-only: the state file still keeps every retained row.
  assert.equal(Object.keys(store.snapshot().sessions).length, DONE_ROWS_PER_PROJECT + 2);
});

test('setWaiting marks a running row and counts it as attention', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it'), turnStart(100)] });
  const { tracker } = makeTracker({ agents: [agent] });
  assert.equal(tracker.getCurrentId(), '');
  assert.equal(tracker.setWaiting('a', true), true);
  const row = tracker.getSnapshot().flatRows.find(item => item.id === 'a');
  assert.equal(row.waiting, true);
  assert.equal(row.waitingAt, 1_000);
  assert.equal(tracker.getSnapshot().unread, 1);
  assert.equal(tracker.setWaiting('a', false), true);
  assert.equal(tracker.getSnapshot().flatRows.find(item => item.id === 'a').waiting, false);
  assert.equal(tracker.getSnapshot().unread, 0);
});

test('setWaiting can lead the row and is applied on the next fold', () => {
  const agents = [];
  const { tracker, harness } = makeTracker({ agents });
  assert.equal(tracker.setWaiting('late', true), true);
  agents.push(makeAgent({ id: 'late', status: 'running', events: [promptEvent('later')] }));
  harness.emit('agent/created', { agent: agents[0] });
  const row = tracker.getSnapshot().flatRows.find(item => item.id === 'late');
  assert.equal(row.waiting, true);
  assert.ok(row.waitingAt > 0);
});

test('a waiting attached row shows the dot but raises no badge or header count', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it'), turnStart(100)] });
  const { tracker } = makeTracker({ agents: [agent], probe: () => 'a' });
  tracker.reconcile();
  assert.equal(tracker.getCurrentId(), 'a');

  const calls = [];
  tracker.setPanelHandle({ badge: (...args) => calls.push(args) }, 'panel');
  assert.equal(tracker.setWaiting('a', true), true);

  const snapshot = tracker.getSnapshot();
  const row = snapshot.flatRows.find(item => item.id === 'a');
  assert.equal(row.waiting, true, 'the row on screen turns into the green dot');
  assert.equal(snapshot.unread, 0, 'the conversation already on screen is not a badge');
  assert.equal(snapshot.groups[0].unread, 0);
  assert.ok(
    calls.every(([, badge]) => badge === null),
    'the tab badge stays clear for the attached session',
  );
});

test('the tab badge counts a parked question while the panel is hidden', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker } = makeTracker({ agents: [agent] });
  const calls = [];
  tracker.setPanelHandle({ badge: (...args) => calls.push(args) }, 'panel');
  tracker.setWaiting('a', true);
  assert.deepEqual(calls.at(-1), ['panel', { level: 'info', unread: 1 }]);
});

test('a disposed agent clears its parked-question flag', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  const { tracker, harness } = makeTracker({ agents: [agent] });
  tracker.setWaiting('a', true);
  harness.emit('agent/disposed', { agent });
  const row = tracker.getSnapshot().flatRows.find(item => item.id === 'a');
  assert.equal(row.waiting, false);
});

test('getCurrentId follows the probe-driven reconcile', () => {
  const agent = makeAgent({ id: 'a', status: 'running', events: [promptEvent('fix it')] });
  let attached = '';
  const { tracker } = makeTracker({ agents: [agent], probe: () => attached });
  assert.equal(tracker.getCurrentId(), '');
  attached = 'a';
  tracker.reconcile();
  assert.equal(tracker.getCurrentId(), 'a');
});
