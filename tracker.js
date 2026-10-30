/**
 * Live roster tracker for the workspace sidebar.
 *
 * One tracker per plugin activation. It folds the core agent registry (and its
 * `agent/created|status|disposed` events) into the tiny row set the panel
 * shows: conversations that are running now, or finished and not yet read.
 *
 * No session files are read. A live agent carries its own session object with
 * the full event log in memory, which is exactly the projection `/resume`
 * itself uses to describe a session; anything older than this process is not
 * visible to the plugin at all (dsh-tui 0.17.0 exposes no cross-process roster).
 */

import {
  applyRowState,
  buildGroups,
  emptyFold,
  foldAgentEvents,
  isUnread,
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
    && left.updatedAt === right.updatedAt
    && left.finishedAt === right.finishedAt
    && left.seenAt === right.seenAt
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
 * }} options
 */
export function createTracker(options) {
  const { ctx, store } = options;
  const logger = options.logger;
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const probe = typeof options.probe === 'function' ? options.probe : undefined;
  const maxRows = Number.isFinite(options.maxRows) && options.maxRows > 0 ? Math.floor(options.maxRows) : 300;

  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, {count: number, state: any}>} */
  const folds = new Map();
  /** @type {{path: string, title: string}[]} */
  let registry = [];
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

  function unreadRows() {
    const out = [];
    for (const [id, row] of rows) {
      if (currentId !== '' && id === currentId) continue;
      if (isUnread(row)) out.push(row);
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
    const next = applyRowState(prev, {
      id,
      cwd,
      title,
      running,
      failed: fold.failed,
      updatedAt: fold.updatedAt,
      currentId,
      now: clock(),
    });
    if (next === undefined) return false;
    if (next.status !== 'running' && !isUnread(next)) {
      if (prev === undefined) return false;
      rows.delete(id);
      return true;
    }
    if (prev !== undefined && sameRow(prev, next)) return false;
    rows.set(id, next);
    return true;
  }

  function setCurrent(nextId) {
    const next = typeof nextId === 'string' ? nextId : '';
    if (next === currentId) return false;
    currentId = next;
    let changed = false;
    if (currentId !== '') {
      for (const [id, row] of [...rows]) {
        if (id !== currentId) continue;
        if (row.status === 'finished') {
          rows.delete(id);
          changed = true;
        }
      }
    }
    if (changed) persist();
    bump();
    return changed;
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

    for (const [id, row] of [...rows]) {
      if (liveIds.has(id)) continue;
      if (row.status === 'running') {
        const next = applyRowState(row, {
          id,
          cwd: row.cwd,
          title: row.title,
          running: false,
          failed: row.failed,
          updatedAt: row.updatedAt,
          currentId,
          now: clock(),
        });
        if (next !== undefined && isUnread(next)) rows.set(id, next);
        else rows.delete(id);
        changed = true;
      } else if (!isUnread(row)) {
        rows.delete(id);
        changed = true;
      }
    }

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
    const row = rows.get(id);
    if (row === undefined || row.status !== 'running') return;
    const next = applyRowState(row, {
      id,
      cwd: row.cwd,
      title: row.title,
      running: false,
      failed: row.failed,
      updatedAt: row.updatedAt,
      currentId,
      now: clock(),
    });
    if (next !== undefined && isUnread(next)) rows.set(id, next);
    else rows.delete(id);
    persist();
    bump();
  }

  function applyRegistry(list) {
    const next = [];
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const path = normalizeCwd(entry.path);
        if (path === '') continue;
        next.push({ path, title: typeof entry.title === 'string' ? entry.title : '' });
      }
    }
    const before = JSON.stringify(registry);
    const after = JSON.stringify(next);
    if (before === after) return;
    registry = next;
    bump();
  }

  function refreshWorkspaces() {
    if (disposed) return;
    let service;
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('tuiWorkspaces', false) : undefined;
    } catch (error) {
      warn('tuiWorkspaces is unavailable', error, logger);
      return;
    }
    if (!service || typeof service.listRegistry !== 'function') return;
    try {
      const result = service.listRegistry();
      if (result && typeof result.then === 'function') {
        void result.then(applyRegistry).catch(error => warn('listRegistry() failed', error, logger));
        return;
      }
      applyRegistry(result);
    } catch (error) {
      warn('listRegistry() failed', error, logger);
    }
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
      for (const [id, row] of Object.entries(persisted)) {
        if (!row || typeof row !== 'object') continue;
        // A row persisted as running was interrupted by the last shutdown; it
        // is history now, not an unfinished task this process can report on.
        if (row.status !== 'finished') continue;
        if (!isUnread(row)) continue;
        if (rows.has(id)) continue;
        rows.set(id, { ...row });
      }
      pruneRows(rows, maxRows, clock());
      // First write after load: capture live rows seeded by attach() and drop
      // persisted rows that are no longer actionable.
      persist();
      bump();
      refreshWorkspaces();
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
    if (row.status === 'running') {
      const now = clock();
      if (row.seenAt === now) return false;
      row.seenAt = now;
      persist();
      return true;
    }
    rows.delete(rowId);
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
      const groups = buildGroups([...rows.values()], registry, currentId);
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
    setPanelVisible,
    setPanelHandle,
    refreshWorkspaces,
    subscribe,
    getSnapshot,
    getVersion,
    dispose,
  };
}
