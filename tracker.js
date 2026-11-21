/**
 * Live roster tracker for the workspace sidebar.
 *
 * One tracker per plugin activation. It folds the core agent registry (and its
 * `agent/created|status|disposed` events) into the tiny row set the panel
 * shows: conversations that are running now, or that finished recently enough
 * to still be worth a glance (the retention window, seven days by default).
 * Reading a row does not remove it; it settles into the dim "seen" state and
 * is swept when the window closes.
 *
 * No session files are read. A live agent carries its own session object with
 * the full event log in memory, which is exactly the projection `/resume`
 * itself uses to describe a session; anything older than this process is not
 * visible to the plugin at all (dsh-tui 0.17.0 exposes no cross-process roster).
 *
 * Inbox membership follows the durable workspace ledger when the host mounts
 * one. A workspace removed from dsh-TUI's home rail therefore disappears from
 * this list (and from the unread badge) at the next ledger read — startup, a
 * panel mount, or `r` — even though its rows stay in the persisted state file.
 * The filter is fail-open: a host without the ledger service (lite/non-DSH
 * kernels) keeps listing rows restored from disk. A row first observed after
 * the latest ledger snapshot is also kept for a moment, because the host
 * attaches a session to its workspace asynchronously, and a parked question
 * must remain reachable or its turn can never be answered.
 *
 * Ordering is class-first, then anchored to state changes rather than events.
 * Rows are listed as unread finishes, then running conversations, then the ones
 * already dealt with; inside a class a running row is anchored to its current
 * `turn/start` and a finished row to its finish marker. Projects follow the same
 * class priority and, inside a class, the workspace whose newest state change is
 * most recent leads — so the workspace a turn was just started in rises to the
 * top of its class. The fold still keeps the latest event time for the relative
 * label and the retention window, but that value never reorders two concurrent
 * conversations or two workspaces.
 */

import {
  DEFAULT_RETENTION_MS,
  applyRowState,
  buildGroups,
  emptyFold,
  foldAgentEvents,
  isAttention,
  isUnread,
  isVisible,
  isWaiting,
  nextExpiry,
  normalizeCwd,
  pruneRows,
} from './model.js';

/**
 * @param {any} agent
 * @returns {string}
 */
function agentIdOf(agent) {
  if (!agent || typeof agent !== 'object') return '';
  const id = agent.id;
  return typeof id === 'string' ? id : String(id ?? '');
}

/**
 * @param {any} agent
 * @returns {any}
 */
function headerOf(agent) {
  const header = agent?.session?.header;
  return header && typeof header === 'object' ? header : {};
}

/**
 * @param {any} agent
 * @returns {boolean}
 */
function isSubagent(agent) {
  return headerOf(agent).origin === 'subagent';
}

/**
 * @param {any} agent
 * @returns {readonly any[]}
 */
function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session || typeof session !== 'object') return [];
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    }
    if (Array.isArray(session.events)) return session.events;
  } catch {
    // A session torn down mid-read is not worth failing a reconcile over.
  }
  return [];
}

/**
 * @param {string} message
 * @param {unknown} [error]
 * @param {{warn?: (message: string) => void} | undefined} [logger]
 */
function warn(message, error, logger) {
  try {
    const tail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
    logger?.warn?.(`workspace-sidebar: ${message}${tail}`);
  } catch {
    // Logging must never break the tracker.
  }
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function sameRow(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id
    && left.cwd === right.cwd
    && left.title === right.title
    && left.status === right.status
    && left.failed === right.failed
    && Boolean(left.plan) === Boolean(right.plan)
    && Boolean(left.waiting) === Boolean(right.waiting)
    && (Number(left.waitingAt) || 0) === (Number(right.waitingAt) || 0)
    && left.updatedAt === right.updatedAt
    && left.finishedAt === right.finishedAt
    && left.seenAt === right.seenAt
    && (Number(left.runningAt) || 0) === (Number(right.runningAt) || 0)
  );
}

/**
 * @param {{
 *   ctx: any,
 *   store: any,
 *   logger?: {warn?: (message: string) => void},
 *   now?: () => number,
 *   probe?: () => string | undefined,
 *   maxRows?: number,
 *   retentionMs?: number,
 * }} options
 */
export function createTracker(options) {
  const { ctx, store } = options;
  const logger = options.logger;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const probe = typeof options.probe === 'function' ? options.probe : undefined;
  const maxRows = Number.isFinite(options.maxRows) && options.maxRows > 0 ? Math.floor(options.maxRows) : 300;
  const retentionMs = Number.isFinite(options.retentionMs) && options.retentionMs >= 0
    ? Number(options.retentionMs)
    : DEFAULT_RETENTION_MS;

  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, {count: number, state: any}>} */
  const folds = new Map();
  /**
   * Agents whose turn is parked on a background question. The set can lead the
   * row (the relay may park before the agent is tracked), so `upsertAgent`
   * applies it on every fold. It is deliberately not persisted.
   * @type {Set<string>}
   */
  const waitingIds = new Set();
  /** @type {{path: string, title: string}[]} */
  let registry = [];
  /** Normalized paths of the workspaces in the latest ledger snapshot. */
  const registered = new Set();
  /**
   * Whether the ledger has ever been read successfully. A host that does not
   * mount the durable registry (lite/non-DSH kernels) never sets this, so its
   * persisted rows keep the old fail-open behaviour.
   */
  let registryKnown = false;
  /** How many successful ledger reads have landed. */
  let registryGeneration = 0;
  /**
   * The ledger generation a row was first observed in. The host attaches a
   * session to its workspace asynchronously, so a brand-new row can briefly
   * name a workspace the cached snapshot has not seen yet. Rows first seen in
   * the current generation are kept until the next successful read; a removed
   * workspace's older rows never qualify. Restored rows have no entry and are
   * filtered immediately.
   * @type {Map<string, number>}
   */
  const firstSeenGeneration = new Map();
  /** @type {Promise<void> | undefined} */
  let refreshing;
  let agentsService;
  let currentId = '';
  let panelVisible = false;
  /** @type {{panels: any, id: string} | undefined} */
  let panelHandle;
  let version = 0;
  let snapshot;
  let lastBadge = 'init';
  let disposed = false;
  let loading;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let expiryTimer;
  let expiryAt = 0;
  const listeners = new Set();
  const disposers = [];

  function bump() {
    version += 1;
    snapshot = undefined;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A render subscriber must not break other subscribers.
      }
    }
    updateBadge();
    scheduleExpiry();
  }

  /**
   * The panel refreshes once a second while it is visible, but a hidden panel
   * must still drop expired rows and shrink the badge on time. One unref'd
   * timer points at the next expiry instead of polling.
   */
  function scheduleExpiry() {
    if (disposed) return;
    const at = nextExpiry(rows, retentionMs, currentId);
    if (at === expiryAt) return;
    expiryAt = at;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (at === 0) return;
    // +1 ms so the sweep runs strictly after the window closes; firing exactly
    // on the boundary would leave the row visible and nothing to re-arm.
    const delay = Math.max(50, Math.min(at - clock() + 1, 2_147_483_647));
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      expiryAt = 0;
      reconcile();
    }, delay);
    expiryTimer.unref?.();
  }

  function persist() {
    // `attach()` can seed live agents before the asynchronous store load has
    // read the file. Writing then would replace unread rows restored a moment
    // later; `load()` performs the first write once both sides are merged.
    if (typeof store.isLoaded === 'function' && store.isLoaded() === false) return;
    const sessions = {};
    for (const [id, row] of rows) sessions[id] = row;
    try {
      store.save(sessions);
    } catch (error) {
      warn('saving state failed', error, logger);
    }
  }

  /**
   * Drop a row and its grace marker together. Sweeps that mutate `rows`
   * directly (the model's `pruneRows`) are followed by `sweepFirstSeen()`.
   * @param {string} id
   */
  function forgetRow(id) {
    rows.delete(id);
    firstSeenGeneration.delete(id);
  }

  /**
   * Drop grace markers whose rows are gone.
   */
  function sweepFirstSeen() {
    for (const id of firstSeenGeneration.keys()) {
      if (!rows.has(id)) firstSeenGeneration.delete(id);
    }
  }

  /**
   * Whether a tracked row belongs on the inbox surface right now.
   *
   * The durable workspace ledger is the authority for which workspaces exist.
   * A row whose cwd is no longer registered is hidden, but the rule is
   * fail-open in every case where the plugin cannot know:
   *
   * - before the first successful ledger read;
   * - on a host with no durable ledger at all (lite/non-DSH kernels);
   * - for the empty-cwd bucket, which has no workspace to match;
   * - for a row first observed in the current ledger generation, because the
   *   host attaches a session to its workspace asynchronously;
   * - for a parked question, which must stay reachable or its turn hangs.
   *
   * @param {any} row
   * @returns {boolean}
   */
  function isInboxRow(row) {
    if (!row || typeof row !== 'object') return false;
    const path = normalizeCwd(row.cwd);
    if (path === '') return true;
    if (!registryKnown) return true;
    if (registered.has(path)) return true;
    if (isWaiting(row)) return true;
    const firstSeen = firstSeenGeneration.get(row.id);
    return firstSeen !== undefined && firstSeen === registryGeneration;
  }

  function inboxRows() {
    const out = [];
    for (const row of rows.values()) {
      if (isInboxRow(row)) out.push(row);
    }
    return out;
  }

  function unreadRows() {
    const out = [];
    for (const [id, row] of rows) {
      if (!isInboxRow(row)) continue;
      if (currentId !== '' && id === currentId) continue;
      if (isAttention(row)) out.push(row);
    }
    return out;
  }

  function updateBadge() {
    if (panelHandle === undefined) return;
    const unread = unreadRows();
    const count = unread.length;
    const level = unread.some(row => row.failed) ? 'warning' : 'info';
    const key = panelVisible || count === 0 ? 'clear' : `${count}:${level}`;
    if (key === lastBadge) return;
    lastBadge = key;
    try {
      if (key === 'clear') panelHandle.panels.badge(panelHandle.id, null);
      else panelHandle.panels.badge(panelHandle.id, { level, unread: count });
    } catch (error) {
      warn('updating the tab badge failed', error, logger);
    }
  }

  function listAgents() {
    if (!agentsService || typeof agentsService.list !== 'function') return [];
    try {
      const list = agentsService.list();
      return Array.isArray(list) ? list : [];
    } catch (error) {
      warn('agents.list() failed', error, logger);
      return [];
    }
  }

  /**
   * Fold only the tail of an agent's log. The whole log is re-read on the first
   * sighting (needed for resumed sessions, whose history is already in memory),
   * then only new events are consumed.
   * @param {any} agent
   */
  function foldOf(agent) {
    const id = agentIdOf(agent);
    const events = sessionEventsOf(agent);
    let entry = folds.get(id);
    if (entry === undefined || events.length < entry.count) {
      entry = { count: 0, state: emptyFold() };
    }
    const result = foldAgentEvents(events, entry.count, entry.state);
    folds.set(id, { count: result.count, state: result.state });
    return result.state;
  }

  /**
   * @param {any} agent
   * @param {boolean | undefined} statusOverride
   * @returns {boolean} whether the persisted row set changed
   */
  function upsertAgent(agent, statusOverride) {
    if (!agent || typeof agent !== 'object' || isSubagent(agent)) return false;
    const id = agentIdOf(agent);
    if (id === '') return false;
    const header = headerOf(agent);
    const fold = foldOf(agent);
    const prev = rows.get(id);
    const running = statusOverride === undefined ? agent.status === 'running' : Boolean(statusOverride);
    if (!running && fold.prompt === '' && prev === undefined) {
      // A freshly created, never-prompted session has nothing to triage.
      return false;
    }
    const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : (prev?.cwd ?? '');
    const title = fold.title || fold.prompt || prev?.title || '';
    const now = clock();
    const next = applyRowState(prev, {
      id,
      cwd,
      title,
      running,
      failed: fold.failed,
      // Display-only while the row runs: the panel colours a planning turn's
      // spinner. applyRowState clears it on finish; the store never persists it.
      plan: fold.plan,
      // In-memory attention flag: a parked background question. The set is the
      // source of truth because it can be set before the agent is first folded.
      waiting: waitingIds.has(id),
      updatedAt: fold.updatedAt,
      // The row's sort anchor while it runs: the start of its current turn.
      // In-turn events keep updating `updatedAt` without moving the row.
      turnStartedAt: fold.turnStartedAt,
      currentId,
      now,
    });
    if (next === undefined) return false;
    if (!isVisible(next, { currentId, now, retentionMs })) {
      // Outlived the retention window, or a zero window that only keeps unread
      // rows. A never-tracked unseen row is simply ignored.
      if (prev === undefined) return false;
      forgetRow(id);
      return true;
    }
    if (prev !== undefined && sameRow(prev, next)) return false;
    if (prev === undefined) firstSeenGeneration.set(id, registryGeneration);
    rows.set(id, next);
    return true;
  }

  function setCurrent(nextId) {
    const next = typeof nextId === 'string' ? nextId : '';
    if (next === currentId) return false;
    currentId = next;
    let changed = false;
    const row = currentId === '' ? undefined : rows.get(currentId);
    if (row && row.status === 'finished' && isUnread(row)) {
      // Arriving at a conversation is reading it. The row stays — there is no
      // reason to erase the place you just came from — and simply loses its
      // unread dot for the rest of the retention window.
      row.seenAt = Math.max(Number(row.finishedAt) || 0, clock());
      changed = true;
    }
    if (changed) persist();
    bump();
    return changed;
  }

  /**
   * The session the TUI is attached to, as far as the tracker knows. The relay
   * uses it (together with the probe) to decide when a parked question can be
   * re-delivered.
   * @returns {string}
   */
  function getCurrentId() {
    return currentId;
  }

  /**
   * Mark a conversation as parked on a question (or clear the mark).
   *
   * The set is the source of truth: the relay can park a question before the
   * agent has been folded into a row, and `upsertAgent` applies the flag on the
   * next fold. The row fields are display-only; `store.save` drops them, so a
   * restart never resurrects a question whose tool call is gone.
   *
   * @param {string} id
   * @param {boolean} value
   * @returns {boolean} whether anything changed
   */
  function setWaiting(id, value) {
    if (disposed) return false;
    const agentId = typeof id === 'string' ? id : '';
    if (agentId === '') return false;
    const next = value === true;
    const inSet = waitingIds.has(agentId);
    const row = rows.get(agentId);
    const rowWaiting = row?.waiting === true;
    if (inSet === next && (row === undefined || rowWaiting === next)) return false;
    if (next) waitingIds.add(agentId);
    else waitingIds.delete(agentId);
    if (row !== undefined && rowWaiting !== next) {
      if (next) {
        row.waiting = true;
        row.waitingAt = Number(row.waitingAt) > 0 ? Number(row.waitingAt) : clock();
      } else {
        row.waiting = false;
        row.waitingAt = 0;
      }
      persist();
      bump();
    } else {
      // Only the set changed; no row to repaint yet.
      bump();
    }
    return true;
  }

  function readAttached() {
    if (probe === undefined) return undefined;
    try {
      const id = probe();
      return typeof id === 'string' && id !== '' ? id : undefined;
    } catch (error) {
      warn('reading the attached session failed', error, logger);
      return undefined;
    }
  }

  /**
   * Rebuild the live roster. Cheap: only new session events are folded.
   * @returns {boolean}
   */
  function reconcile() {
    if (disposed) return false;
    const attached = readAttached();
    if (attached !== undefined && attached !== currentId) setCurrent(attached);

    let changed = false;
    const liveIds = new Set();
    for (const agent of listAgents()) {
      if (!agent || isSubagent(agent)) continue;
      const id = agentIdOf(agent);
      if (id === '') continue;
      liveIds.add(id);
      if (upsertAgent(agent, undefined)) changed = true;
    }

    const now = clock();
    for (const [id, row] of [...rows]) {
      if (liveIds.has(id)) continue;
      // The agent is gone; any parked question for it can never be answered.
      waitingIds.delete(id);
      if (row.status === 'running') {
        // The agent is gone; the turn it was in can never be reported on now,
        // so it settles as finished with the usual read/unread rule.
        const next = applyRowState(row, {
          id,
          cwd: row.cwd,
          title: row.title,
          running: false,
          failed: row.failed,
          updatedAt: row.updatedAt,
          currentId,
          now,
        });
        if (next !== undefined) rows.set(id, next);
        else forgetRow(id);
        changed = true;
      }
    }
    if (pruneRows(rows, maxRows, now, { currentId, retentionMs }) > 0) changed = true;
    sweepFirstSeen();

    if (changed) {
      persist();
      bump();
    }
    return changed;
  }

  function onCreated(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    if (upsertAgent(agent, undefined)) {
      persist();
      bump();
    }
  }

  function onStatus(payload) {
    const agent = payload?.agent;
    const status = payload?.status;
    if (!agent || (status !== 'running' && status !== 'idle')) return;
    if (upsertAgent(agent, status === 'running')) {
      persist();
      bump();
    }
  }

  function onDisposed(payload) {
    const agent = payload?.agent;
    const id = agentIdOf(agent);
    if (id === '') return;
    folds.delete(id);
    waitingIds.delete(id);
    const row = rows.get(id);
    if (row === undefined || row.status !== 'running') return;
    const now = clock();
    const next = applyRowState(row, {
      id,
      cwd: row.cwd,
      title: row.title,
      running: false,
      failed: row.failed,
      updatedAt: row.updatedAt,
      currentId,
      now,
    });
    if (next !== undefined && isVisible(next, { currentId, now, retentionMs })) rows.set(id, next);
    else forgetRow(id);
    persist();
    bump();
  }

  /**
   * Whether the host mounts the durable workspace registry. A lite/non-DSH
   * composition also provides `tuiWorkspaces`, but its local runtime has no
   * ledger and returns an always-empty `listRegistry()`; that empty list must
   * not be treated as "every workspace was removed".
   * @returns {boolean}
   */
  function ledgerMounted() {
    try {
      return Boolean(typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry', false) : undefined);
    } catch {
      return false;
    }
  }

  /**
   * Replace the cached ledger snapshot. Always bumps: a fresh snapshot may
   * retire the grace of a row that is still absent, even when the titles did
   * not change.
   * @param {unknown} list
   */
  function applyRegistry(list) {
    if (disposed || !Array.isArray(list)) return;
    const next = [];
    const paths = new Set();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const path = normalizeCwd(entry.path);
      if (path === '') continue;
      next.push({ path, title: typeof entry.title === 'string' ? entry.title : '' });
      paths.add(path);
    }
    registry = next;
    registered.clear();
    for (const path of paths) registered.add(path);
    // Keep the last-known-good authority: a read that suddenly looks empty on
    // a host whose registry service is gone must not resurrect removed rows.
    if (ledgerMounted() || next.length > 0) registryKnown = true;
    registryGeneration += 1;
    bump();
  }

  /**
   * Read the durable workspace ledger. Returns the in-flight read so a load and
   * a panel mount in the same tick share one fs sweep.
   * @returns {Promise<void>}
   */
  function refreshWorkspaces() {
    if (disposed) return Promise.resolve();
    if (refreshing !== undefined) return refreshing;
    let service;
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('tuiWorkspaces', false) : undefined;
    } catch (error) {
      warn('tuiWorkspaces is unavailable', error, logger);
      return Promise.resolve();
    }
    if (!service || typeof service.listRegistry !== 'function') return Promise.resolve();
    let result;
    try {
      result = service.listRegistry();
    } catch (error) {
      warn('listRegistry() failed', error, logger);
      return Promise.resolve();
    }
    if (result && typeof result.then === 'function') {
      refreshing = Promise.resolve(result)
        .then(applyRegistry)
        .catch(error => {
          warn('listRegistry() failed', error, logger);
        })
        .finally(() => {
          refreshing = undefined;
        });
      return refreshing;
    }
    applyRegistry(result);
    return Promise.resolve();
  }

  async function load() {
    if (loading !== undefined) return loading;
    loading = (async () => {
      try {
        await store.ready();
      } catch (error) {
        warn('loading state failed', error, logger);
      }
      const persisted = store.snapshot?.()?.sessions ?? {};
      const now = clock();
      for (const [id, row] of Object.entries(persisted)) {
        if (!row || typeof row !== 'object') continue;
        // A row persisted as running was interrupted by the last shutdown; it
        // is history now, not an unfinished task this process can report on.
        if (row.status !== 'finished') continue;
        // Read rows are restored too: "finished a week ago" is exactly the
        // horizon this list is meant to keep.
        if (!isVisible(row, { currentId, now, retentionMs })) continue;
        if (rows.has(id)) continue;
        rows.set(id, { ...row });
      }
      // The attached session may have been persisted as unread by an earlier
      // process; arriving in it is reading it, exactly as setCurrent() does.
      const attached = currentId === '' ? undefined : rows.get(currentId);
      if (attached && attached.status === 'finished' && isUnread(attached)) {
        attached.seenAt = Math.max(Number(attached.finishedAt) || 0, now);
      }
      pruneRows(rows, maxRows, now, { currentId, retentionMs });
      sweepFirstSeen();
      // Read the ledger before the first bump so a removed workspace's
      // persisted rows never flash back onto the panel on startup.
      await refreshWorkspaces();
      // First write after load: capture live rows seeded by attach() and drop
      // persisted rows that are no longer actionable.
      persist();
      bump();
      reconcile();
    })();
    return loading;
  }

  function attach() {
    if (disposed) return;
    if (typeof ctx?.on === 'function') {
      const subscriptions = [
        ['agent/status', onStatus],
        ['agent/disposed', onDisposed],
        ['agent/created', onCreated],
      ];
      for (const [name, handler] of subscriptions) {
        try {
          const off = ctx.on(name, handler);
          if (typeof off === 'function') disposers.push(off);
        } catch (error) {
          warn(`subscribing to ${name} failed`, error, logger);
        }
      }
    }

    try {
      agentsService = typeof ctx?.get === 'function' ? ctx.get('agents', false) : undefined;
    } catch (error) {
      warn('agents is unavailable', error, logger);
    }
    if (agentsService) bump();

    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['agents'], ready => {
          let service;
          try {
            service = ready?.get?.('agents', false) ?? ready?.agents;
          } catch {
            service = undefined;
          }
          if (service && service !== agentsService) {
            agentsService = service;
            bump();
            reconcile();
          }
        });
      } catch (error) {
        warn('waiting for the agents service failed', error, logger);
      }
    }

    if (agentsService) reconcile();
  }

  function markSeen(id) {
    const rowId = typeof id === 'string' ? id : '';
    const row = rows.get(rowId);
    if (row === undefined) return false;
    const now = clock();
    if (row.status === 'running') {
      if (row.seenAt === now) return false;
      row.seenAt = now;
      persist();
      bump();
      return true;
    }
    const nextSeen = Math.max(Number(row.finishedAt) || 0, now);
    if (nextSeen === row.seenAt) return false;
    // Reading a finished row settles it as read but keeps it: the conversation
    // you just jumped to, or deliberately marked, remains visible until its
    // retention window closes.
    row.seenAt = nextSeen;
    persist();
    bump();
    return true;
  }

  function setPanelVisible(value) {
    const next = value === true;
    if (next === panelVisible) return;
    panelVisible = next;
    updateBadge();
  }

  function setPanelHandle(panels, id) {
    if (!panels || typeof panels.badge !== 'function' || typeof id !== 'string' || id === '') return;
    panelHandle = { panels, id };
    lastBadge = 'init';
    updateBadge();
  }

  function getSnapshot() {
    if (snapshot === undefined) {
      const groups = buildGroups(inboxRows(), registry, currentId, {
        now: clock(),
        retentionMs,
      });
      snapshot = {
        ...groups,
        currentId,
        agentsAvailable: Boolean(agentsService),
        version,
      };
    }
    return snapshot;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getVersion() {
    return version;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    expiryAt = 0;
    listeners.clear();
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {
        // Disposal is best-effort.
      }
    }
  }

  return {
    attach,
    load,
    reconcile,
    markSeen,
    setCurrent,
    setWaiting,
    getCurrentId,
    setPanelVisible,
    setPanelHandle,
    refreshWorkspaces,
    subscribe,
    getSnapshot,
    getVersion,
    dispose,
  };
}
