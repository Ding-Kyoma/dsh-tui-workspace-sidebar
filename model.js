/**
 * Pure model for the workspace sidebar.
 *
 * Everything here is synchronous and side-effect free so the interesting
 * decisions — what counts as unread, who belongs in a project group, which
 * glyph a row gets — can be unit-tested without a TUI, a React renderer or a
 * live agent registry.
 */

/** The chat's own thinking spinner, frame for frame. @type {readonly string[]} */
export const RUNNING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Frame interval used by the chat's spinner. */
export const RUNNING_FRAME_MS = 80;

/**
 * How long a finished conversation stays in the inbox after its last activity.
 *
 * The row survives reading it: clicking a row no longer removes it, it settles
 * into a dim checkmark and is swept once the window closes. The attached
 * session is pinned regardless of age — it is where the person is looking.
 */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Finished-unread rows are highlighted for this long after they land. */
export const FRESH_FINISH_MS = 4_000;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return '';
  let path = value.trim();
  if (path === '') return '';
  // Windows separators never appear on the platforms dsh-tui ships for, but a
  // session may be resumed from a log written elsewhere; normalising them keeps
  // one directory from splitting into two groups.
  path = path.replace(/\\/g, '/');
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function basename(value) {
  const path = normalizeCwd(value);
  if (path === '') return '';
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1) || path;
}

/**
 * Collapse arbitrary message text into one trimmed display line.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(value, max = 200) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Text of a message's content blocks. Only `text` blocks are rendered; a
 * tool-call block would leak JSON into a one-line title.
 * @param {unknown} content
 * @returns {string}
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join(' ');
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  return contentText(message.content);
}

/**
 * A fresh folding state.
 * @returns {{count: number, title: string, prompt: string, summary: string, updatedAt: number, turnStartedAt: number, plan: boolean, failed: boolean}}
 */
export function emptyFold() {
  return { count: 0, title: '', prompt: '', summary: '', updatedAt: 0, turnStartedAt: 0, plan: false, failed: false };
}

/**
 * Fold new session events into a previously folded state.
 *
 * `fromIndex` is the number of events already folded; only the tail is read, so
 * a running session's whole log is not re-scanned on every status change.
 *
 * `updatedAt` tracks the newest event (it drives the relative time and the
 * retention window). `turnStartedAt` tracks the newest `turn/start` event: it is
 * the ordering anchor for a running row, so the hundreds of events inside one
 * turn cannot make two concurrent conversations trade places.
 *
 * `plan` is the durable plan-mode selection (`dsh-plan-mode` appends
 * `plan/mode` at each accepted boundary). It is folded last-wins exactly like
 * dsh-tui's own status-line indicator, so a resumed session that already has
 * the event history is classified correctly on first sight.
 *
 * @param {readonly unknown[]} events
 * @param {number} fromIndex
 * @param {{count: number, title: string, prompt: string, summary: string, updatedAt: number, turnStartedAt?: number, plan?: boolean, failed: boolean}} state
 * @returns {{state: {count: number, title: string, prompt: string, summary: string, updatedAt: number, turnStartedAt: number, plan: boolean, failed: boolean}, count: number}}
 */
export function foldAgentEvents(events, fromIndex, state) {
  const input = Array.isArray(events) ? events : [];
  const start = Number.isFinite(fromIndex) && fromIndex >= 0 ? Math.min(Math.floor(fromIndex), input.length) : 0;
  let { title, prompt, summary, updatedAt, failed } = state;
  // A caller may hand in a state folded before the anchor existed; treat it as 0.
  let turnStartedAt = Number(state?.turnStartedAt) || 0;
  // Same tolerance for the plan flag: an older fold state simply means "off".
  let plan = state?.plan === true;
  for (let index = start; index < input.length; index += 1) {
    const event = input[index];
    if (!event || typeof event !== 'object') continue;
    const time = Number(event.time);
    if (Number.isFinite(time) && time > 0) updatedAt = Math.max(updatedAt, time);
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    switch (event.type) {
      case 'turn/start': {
        if (Number.isFinite(time) && time > 0) turnStartedAt = Math.max(turnStartedAt, time);
        break;
      }
      case 'plan/mode': {
        // Only a boolean is a valid durable selection; a malformed payload
        // keeps the previous state instead of flapping the row colour.
        if (typeof data.active === 'boolean') plan = data.active;
        break;
      }
      case 'session/title': {
        const next = typeof data.title === 'string' ? oneLine(data.title, 120) : '';
        if (next !== '') title = next;
        break;
      }
      case 'user/message': {
        if (prompt !== '') break;
        const kind = data.source && typeof data.source === 'object' ? data.source.kind : undefined;
        if (kind !== 'user') break;
        const text = oneLine(messageText(data), 80);
        if (text !== '') prompt = text;
        break;
      }
      case 'assistant/message': {
        const text = oneLine(messageText(data.message), 120);
        if (text !== '') summary = text;
        break;
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? oneLine(data.name, 40) : '';
        if (name !== '') summary = name;
        break;
      }
      case 'turn/end': {
        const kind = data.reason && typeof data.reason === 'object' ? data.reason.kind : undefined;
        // Only an error settlement arms the ✕ glyph; aborted turns are user
        // intent, not a failure worth flagging in the inbox.
        if (kind === 'error') failed = true;
        else if (kind === 'completed' || kind === 'aborted') failed = false;
        break;
      }
      default:
        break;
    }
  }
  return { state: { count: input.length, title, prompt, summary, updatedAt, turnStartedAt, plan, failed }, count: input.length };
}

/**
 * @param {{status?: string, finishedAt?: number, seenAt?: number}} row
 * @returns {boolean}
 */
export function isUnread(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.status !== 'finished') return false;
  return Number(row.finishedAt) > Number(row.seenAt);
}

/**
 * Whether the conversation is parked on a question for the person.
 *
 * A background session that asks `ask_user_question` / `exit_plan_mode` cannot
 * reach the TUI's answerer (it is bound to the attached channel), so the
 * question relay parks it instead of letting the turn fail. The row carries the
 * flag until the question settles; it is in-memory only and never persisted.
 *
 * @param {{waiting?: boolean}} row
 * @returns {boolean}
 */
export function isWaiting(row) {
  if (!row || typeof row !== 'object') return false;
  return row.waiting === true;
}

/**
 * Whether a row wants the person's attention: a finished turn nobody has read,
 * or a background question parked for an answer. Both use the same green dot.
 *
 * @param {any} row
 * @returns {boolean}
 */
export function isAttention(row) {
  return isWaiting(row) || isUnread(row);
}

/**
 * Last moment anything happened in a row. The finish marker can be observed a
 * moment after the final event, so the later of the two wins.
 *
 * This is the activity clock: it feeds the relative time and the retention
 * window. It is deliberately *not* the sort key — see {@link orderAtOf}.
 *
 * @param {{updatedAt?: number, finishedAt?: number}} row
 * @returns {number}
 */
export function activityAt(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.max(Number(row.updatedAt) || 0, Number(row.finishedAt) || 0);
}

/**
 * The ordering anchor: when the row's current state began.
 *
 * A running row is anchored to the start of its turn, not to its latest event.
 * A turn emits hundreds of events (tool calls, results, steps, background job
 * churn), so sorting by activity made two conversations that run at the same
 * time trade places on every event. The anchor only moves when the state moves.
 * A finished row is anchored to its finish marker, so a late title or job event
 * cannot lift it afterwards either.
 *
 * Rows without an anchor (restored from disk, hand-built in tests) fall back to
 * their activity time, which keeps the previous ordering for them.
 *
 * @param {any} row
 * @returns {number}
 */
export function orderAtOf(row) {
  if (!row || typeof row !== 'object') return 0;
  if (isWaiting(row)) {
    // A parked question is an event of its own: the row should surface at the
    // moment it started waiting, not at the start of the turn that asked.
    const waitingAt = Number(row.waitingAt);
    if (waitingAt > 0) return waitingAt;
  }
  if (row.status === 'running') {
    const anchor = Number(row.runningAt);
    return anchor > 0 ? anchor : activityAt(row);
  }
  const finished = Number(row.finishedAt);
  return finished > 0 ? finished : activityAt(row);
}

/**
 * Triage classes, in the order they are listed: finished-but-unread first,
 * then running conversations, then everything already dealt with. Sorting is
 * class-first; the anchor ({@link orderAtOf}) only breaks ties inside a class.
 */
export const RANK_UNREAD = 0;
export const RANK_RUNNING = 1;
export const RANK_DONE = 2;

/**
 * How many already-read finished conversations one project may show.
 *
 * The cap is per project and display-only: running and unread rows are never
 * trimmed, and the tracker keeps every row the retention window allows. It
 * bounds how far back a busy project's history reaches without shortening the
 * window itself.
 *
 * It is the *maximum*: when the panel is too short for the whole grouped list,
 * {@link fitGroups} lowers it for every project until the list fits, never
 * below {@link MIN_DONE_ROWS_PER_PROJECT}.
 */
export const DONE_ROWS_PER_PROJECT = 10;

/**
 * The floor for the adaptive cap applied by {@link fitGroups}.
 *
 * A project always keeps this many already-read conversations, even when the
 * panel is shorter than the resulting list: below this point the panel scrolls
 * as it always did instead of folding away any more history.
 */
export const MIN_DONE_ROWS_PER_PROJECT = 3;

/**
 * The triage class of a row. A failed finish is still a finish: it belongs in
 * the unread class until it has been read or leaves the retention window.
 *
 * @param {any} row
 * @returns {0 | 1 | 2}
 */
export function rankOf(row) {
  if (!row || typeof row !== 'object') return RANK_DONE;
  if (isWaiting(row)) return RANK_UNREAD;
  if (row.status === 'running') return RANK_RUNNING;
  if (isUnread(row)) return RANK_UNREAD;
  return RANK_DONE;
}

/**
 * @typedef {{currentId?: string, now?: number, retentionMs?: number}} ViewOptions
 */

/**
 * @param {ViewOptions} [options]
 * @returns {{currentId: string, now: number, retentionMs: number}}
 */
function viewOf(options = {}) {
  return {
    currentId: String(options.currentId ?? ''),
    now: Number.isFinite(options.now) ? Number(options.now) : Date.now(),
    retentionMs: Number.isFinite(options.retentionMs) ? Number(options.retentionMs) : DEFAULT_RETENTION_MS,
  };
}

/**
 * Whether a tracked row still belongs on screen.
 *
 * Running rows always do, and so does the attached session: it is what the
 * person is looking at, and pinning it gives the panel's highlight a stable
 * home. A finished row stays for the whole retention window — read or not —
 * so a jump does not erase the conversation you just came from. A zero window
 * restores the old rule: finished rows live only while unread.
 *
 * @param {any} row
 * @param {ViewOptions} [options]
 * @returns {boolean}
 */
export function isVisible(row, options = {}) {
  if (!row || typeof row !== 'object') return false;
  if (isWaiting(row)) return true;
  if (row.status === 'running') return true;
  const view = viewOf(options);
  if (view.currentId !== '' && String(row.id) === view.currentId) return true;
  if (view.retentionMs <= 0) return isUnread(row);
  return view.now - activityAt(row) <= view.retentionMs;
}

/**
 * The one transition table for a tracked row.
 *
 * `prev` is the row currently tracked (or undefined). The return value is the
 * next row, or undefined when there is nothing to track. A row that is the
 * attached session is adopted even the first time it is seen, so the panel
 * always has a highlight to land on; visibility over time is decided later by
 * {@link isVisible} and {@link pruneRows}.
 *
 * `runningAt` is the row's ordering anchor while it runs ({@link orderAtOf}).
 * It is captured once per turn and never advanced by in-turn events, which is
 * what keeps concurrent running conversations from swapping places. The field
 * is in-memory only: a running row is dropped on the next start anyway.
 *
 * `plan` is a display-only flag copied from the fold while the row runs; a
 * finished row always clears it, because the inbox only colours a spinner
 * that is actually spinning.
 *
 * `waiting` is set while a background question is parked for the person. It is
 * cleared when the question settles or the turn finishes. Like `plan` and
 * `runningAt`, it is in-memory only and never written to the store.
 *
 * @param {any} prev
 * @param {{
 *   id: string,
 *   cwd: string,
 *   title: string,
 *   running: boolean,
 *   failed?: boolean,
 *   plan?: boolean,
 *   waiting?: boolean,
 *   updatedAt: number,
 *   turnStartedAt?: number,
 *   currentId: string,
 *   now: number,
 * }} input
 * @returns {any}
 */
export function applyRowState(prev, input) {
  const id = String(input.id ?? '');
  if (id === '') return undefined;
  const cwd = normalizeCwd(input.cwd) || normalizeCwd(prev?.cwd);
  const title = typeof input.title === 'string' ? input.title : (prev?.title ?? '');
  const updatedAt = Number.isFinite(input.updatedAt) && input.updatedAt > 0
    ? input.updatedAt
    : Number(prev?.updatedAt) || 0;
  const isCurrent = id === String(input.currentId ?? '');

  if (input.running) {
    // The anchor is monotonic: a new turn moves it forward, an old log tail
    // (or a fold reset after compaction) never drags it backwards. The last
    // event time is only used when the row is first observed and the log has
    // no turn marker to offer.
    const prevAnchor = prev?.status === 'running' ? Number(prev.runningAt) || 0 : 0;
    const turnAnchor = Number(input.turnStartedAt) || 0;
    const runningAt = Math.max(prevAnchor, turnAnchor)
      || updatedAt
      || (Number(input.now) || Date.now());
    const waiting = input.waiting === true;
    const waitingAt = waiting
      ? (prev?.waiting === true && Number(prev.waitingAt) > 0
        ? Number(prev.waitingAt)
        : (Number(input.now) || Date.now()))
      : 0;
    return {
      id,
      cwd,
      title,
      status: 'running',
      failed: Boolean(input.failed),
      plan: input.plan === true,
      waiting,
      waitingAt,
      updatedAt,
      finishedAt: 0,
      seenAt: Number(prev?.seenAt) || 0,
      runningAt,
    };
  }

  if (prev?.status === 'running') {
    const finishedAt = Number(input.now) || Date.now();
    return {
      id,
      cwd,
      title,
      status: 'finished',
      failed: Boolean(input.failed),
      plan: false,
      waiting: false,
      waitingAt: 0,
      updatedAt: updatedAt || finishedAt,
      finishedAt,
      // A session the person is actively looking at settles as read: a badge
      // for the conversation already on screen would be pure noise.
      seenAt: isCurrent ? finishedAt : Number(prev.seenAt) || 0,
      runningAt: 0,
    };
  }

  if (prev === undefined) {
    if (!isCurrent) return undefined;
    // The attached session is worth listing even when nothing is running: it
    // is where the person is, and it is the row the panel highlights. It is
    // adopted as read — nothing was missed while it was on screen.
    const finishedAt = updatedAt > 0 ? updatedAt : (Number(input.now) || Date.now());
    const waiting = input.waiting === true;
    return {
      id,
      cwd,
      title,
      status: 'finished',
      failed: Boolean(input.failed),
      plan: false,
      waiting,
      waitingAt: waiting ? (Number(input.now) || Date.now()) : 0,
      updatedAt: finishedAt,
      finishedAt,
      seenAt: finishedAt,
      runningAt: 0,
    };
  }

  const finishedAt = Number(prev.finishedAt) || 0;
  const waiting = input.waiting === undefined ? prev.waiting === true : input.waiting === true;
  const next = {
    id,
    cwd,
    title,
    status: prev.status === 'finished' ? 'finished' : prev.status,
    failed: input.failed === undefined ? Boolean(prev.failed) : Boolean(input.failed),
    plan: false,
    waiting,
    waitingAt: waiting
      ? (Number(prev.waitingAt) > 0 ? Number(prev.waitingAt) : (Number(input.now) || Date.now()))
      : 0,
    updatedAt: Math.max(Number(prev.updatedAt) || 0, updatedAt),
    finishedAt,
    seenAt: Number(prev.seenAt) || 0,
    runningAt: 0,
  };
  if (next.status === 'finished' && isCurrent) next.seenAt = Math.max(next.seenAt, finishedAt);
  return next;
}

/**
 * Sweep rows that have outlived their welcome.
 *
 * The retention window is the real rule: every finished row — read or unread —
 * disappears once it has been idle for that long. The attached session is never
 * swept while it is attached. The row cap remains as a hard bound for very
 * long-running processes; when it bites, the least recently active finished
 * rows go first.
 *
 * @param {Map<string, any>} rows mutated in place
 * @param {number} max
 * @param {number} now
 * @param {ViewOptions} [options]
 * @returns {number} how many rows were removed
 */
export function pruneRows(rows, max, now, options = {}) {
  if (!(rows instanceof Map)) return 0;
  const view = viewOf({ ...options, now });
  let removed = 0;
  for (const [id, row] of rows) {
    if (!row || row.status === 'running') continue;
    if (isVisible(row, view)) continue;
    rows.delete(id);
    removed += 1;
  }
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 300;
  if (rows.size <= limit) return removed;
  const finished = [...rows.entries()]
    .filter(([id, row]) => row?.status === 'finished' && row?.waiting !== true && id !== view.currentId)
    .sort((left, right) => activityAt(left[1]) - activityAt(right[1]));
  while (rows.size > limit && finished.length > 0) {
    const [id] = finished.shift();
    rows.delete(id);
    removed += 1;
  }
  return removed;
}

/**
 * When the next row is due to be swept (epoch ms), or 0 when nothing is
 * waiting. Running and attached rows never expire by themselves.
 *
 * @param {Map<string, any>} rows
 * @param {number} retentionMs
 * @param {string} currentId
 * @returns {number}
 */
export function nextExpiry(rows, retentionMs, currentId) {
  if (!(rows instanceof Map)) return 0;
  const retention = Number.isFinite(retentionMs) ? Number(retentionMs) : DEFAULT_RETENTION_MS;
  if (retention <= 0) return 0;
  const current = String(currentId ?? '');
  let earliest = 0;
  for (const [id, row] of rows) {
    if (!row || row.status === 'running') continue;
    if (isWaiting(row)) continue;
    if (current !== '' && id === current) continue;
    const at = activityAt(row) + retention;
    if (earliest === 0 || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * @typedef {{id: string, cwd: string, title: string, status: string, failed: boolean, plan?: boolean, waiting?: boolean, waitingAt?: number, updatedAt: number, finishedAt: number, seenAt: number, runningAt?: number}} SidebarRow
 */

/**
 * Rows the sidebar is allowed to show: running, the attached session, and
 * finished rows still inside the retention window. Order is left to the caller.
 *
 * @param {readonly SidebarRow[]} rows
 * @param {string} currentId
 * @param {ViewOptions} [options]
 * @returns {SidebarRow[]}
 */
export function visibleRows(rows, currentId, options = {}) {
  const view = viewOf({ ...options, currentId });
  const out = [];
  for (const row of rows) {
    if (!isVisible(row, view)) continue;
    out.push(row);
  }
  return out;
}

/**
 * Newest state first, by the row's ordering anchor ({@link orderAtOf}): a
 * running row is anchored to its turn start, a finished row to its finish
 * marker. Activity *inside* a turn never reorders the list, so two concurrent
 * conversations keep a fixed relative order instead of trading places on every
 * event. The id makes the order total when two rows share an anchor.
 * This only orders rows that share a triage class — see {@link compareByTriage}.
 * @param {SidebarRow} left
 * @param {SidebarRow} right
 * @returns {number}
 */
function compareByOrder(left, right) {
  const leftAt = orderAtOf(left);
  const rightAt = orderAtOf(right);
  if (leftAt !== rightAt) return rightAt - leftAt;
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

/**
 * Class first, recency second: everything unread, then everything running,
 * then the conversations already dealt with. Inside a class the anchor decides,
 * so the two rules never fight each other.
 * @param {SidebarRow} left
 * @param {SidebarRow} right
 * @returns {number}
 */
function compareByTriage(left, right) {
  const leftRank = rankOf(left);
  const rightRank = rankOf(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareByOrder(left, right);
}

/**
 * Trim a project's already-read finished rows to the display cap.
 *
 * `rows` must already be sorted by {@link compareByTriage}, which puts unread
 * and running rows first and orders the done class newest-first. Only the
 * trailing done class is affected. The attached conversation is guaranteed a
 * slot: when it is a done row outside the cap, it displaces the oldest kept row
 * so the list never exceeds the cap and the panel always has a row to land on.
 *
 * `cap` defaults to {@link DONE_ROWS_PER_PROJECT}; {@link fitGroups} re-applies
 * this helper with a smaller cap when the panel is too short.
 *
 * @param {readonly SidebarRow[]} rows
 * @param {string} currentId
 * @param {number} [cap]
 * @returns {SidebarRow[]}
 */
function capDoneRows(rows, currentId, cap = DONE_ROWS_PER_PROJECT) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DONE_ROWS_PER_PROJECT;
  const done = rows.filter(row => rankOf(row) === RANK_DONE);
  if (done.length <= limit) return rows;
  const kept = new Set(done.slice(0, limit));
  const current = done.find(row => String(row.id) === currentId);
  if (current !== undefined && !kept.has(current)) {
    kept.delete(done[limit - 1]);
    kept.add(current);
  }
  return rows.filter(row => rankOf(row) !== RANK_DONE || kept.has(row));
}

/**
 * Group visible rows by project, triage class first and newest state second
 * inside each project. Projects follow the same class priority — a project
 * whose top row is unread leads, then one with a running conversation, then the
 * rest — so the very first rows of the panel are always the ones that want
 * attention. Inside a class the workspace whose newest state change is most
 * recent leads, so the workspace you just started a turn in sits at the top of
 * its class instead of staying at the slot where it first appeared. The key is
 * the same anchor rows use ({@link orderAtOf}): in-turn activity never reorders
 * projects, so only a state change — a turn starting, a turn finishing, a
 * question being parked — moves one, and it moves once. An exact tie falls back
 * to the first-seen slot, then to the path.
 *
 * At most {@link DONE_ROWS_PER_PROJECT} already-read finished conversations are
 * listed per project. Running and unread rows are never trimmed, and the
 * attached conversation keeps a slot even when an older read row would
 * otherwise be cut. The cap is display-only: the tracker still retains rows for
 * the whole retention window, so the next-oldest conversation appears once a
 * kept row leaves.
 *
 * The attached session is listed too; it is simply never counted as unread.
 *
 * @param {readonly SidebarRow[]} rows
 * @param {readonly {path?: string, title?: string}[]} registry
 * @param {string} currentId
 * @param {ViewOptions} [options]
 * @returns {{
 *   groups: {key: string, title: string, cwd: string, running: number, unread: number, rows: SidebarRow[]}[],
 *   running: number,
 *   unread: number,
 *   flatRows: SidebarRow[],
 * }}
 */
export function buildGroups(rows, registry, currentId, options = {}) {
  const current = String(currentId ?? '');
  const visible = visibleRows(rows, current, options);
  const titles = new Map();
  if (Array.isArray(registry)) {
    for (const entry of registry) {
      if (!entry || typeof entry !== 'object') continue;
      const key = normalizeCwd(entry.path);
      if (key === '') continue;
      const title = typeof entry.title === 'string' ? oneLine(entry.title, 80) : '';
      if (title !== '') titles.set(key, title);
    }
  }

  // First-seen slot per project: a tie-break only, for two workspaces whose
  // newest state change landed in the same millisecond. It comes from the
  // tracker's row order, not from any activity clock.
  const order = new Map();
  const buckets = new Map();
  for (const row of visible) {
    const key = normalizeCwd(row.cwd) || 'unknown';
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, cwd: key === 'unknown' ? '' : row.cwd, rows: [] };
      buckets.set(key, bucket);
      order.set(key, order.size);
    }
    bucket.rows.push(row);
  }

  const projects = [...buckets.values()].map(bucket => {
    const list = capDoneRows([...bucket.rows].sort(compareByTriage), current);
    // Newest state change in the whole project, not in the capped display list:
    // the class ordering must not depend on the row cap or on the panel's
    // height folding. The attached row's pin can pull an older read row into
    // `list`; it must not drag the project down with it.
    let activity = 0;
    for (const row of bucket.rows) activity = Math.max(activity, orderAtOf(row));
    let running = 0;
    let unread = 0;
    for (const row of list) {
      if (row.status === 'running') running += 1;
      // A parked question is attention even while its turn is still running;
      // it is also counted in `running`, so the header says both "running" and
      // "unread" rather than hiding one of the two facts.
      if (isAttention(row) && String(row.id) !== current) unread += 1;
    }
    const title = titles.get(bucket.key) ?? basename(bucket.cwd) ?? '';
    return {
      key: bucket.key,
      title: title === '' ? '' : title,
      cwd: bucket.cwd,
      running,
      unread,
      rows: list,
      order: order.get(bucket.key) ?? 0,
      activity,
    };
  });

  projects.sort((left, right) => {
    const leftRank = left.rows.length > 0 ? rankOf(left.rows[0]) : RANK_DONE;
    const rightRank = right.rows.length > 0 ? rankOf(right.rows[0]) : RANK_DONE;
    if (leftRank !== rightRank) return leftRank - rightRank;
    // Inside a class the workspace that changed state most recently leads: a
    // new turn lifts its workspace to the front, and the anchor only moves when
    // the state does, so in-turn events never reshuffle the projects.
    if (left.activity !== right.activity) return right.activity - left.activity;
    // Same anchor (two workspaces settling in the same millisecond): fall back
    // to where the project first appeared, then to the path, so the order stays
    // total and deterministic.
    if (left.order !== right.order) return left.order - right.order;
    return left.key.localeCompare(right.key);
  });

  const flatRows = [];
  let running = 0;
  let unread = 0;
  for (const project of projects) {
    running += project.running;
    unread += project.unread;
    flatRows.push(...project.rows);
  }
  return {
    groups: projects.map(({ order: _order, activity: _activity, ...rest }) => rest),
    running,
    unread,
    flatRows,
  };
}

/**
 * Fold already-read conversations until the grouped list fits the panel.
 *
 * The panel body has a fixed number of lines, and every project header is one
 * of them. With enough workspaces the fixed {@link DONE_ROWS_PER_PROJECT} cap
 * alone can overflow that budget, forcing a scroll for rows that are only
 * history. This function lowers the cap for *every* project together —
 * 9, 8, … — and stops at the first cap whose grouped list fits, so the panel
 * keeps as much history as the height allows. It never goes below
 * {@link MIN_DONE_ROWS_PER_PROJECT}; at that floor the list is returned as
 * trimmed and `overflow` is true, letting the panel scroll as before.
 *
 * Only the done class is affected. Running, waiting and unread rows are never
 * folded, and {@link capDoneRows} still pins the attached conversation, so the
 * row the person is looking at cannot disappear. The result is display-only:
 * the tracker keeps every row the retention window allows, and a taller panel
 * (or a shorter list) reveals the folded conversations again.
 *
 * A non-positive or non-finite `capacity` means "no viewport information"
 * (tests, non-TUI callers); the list is returned untouched.
 *
 * `groups` must come from {@link buildGroups}: each project's rows are already
 * triage-sorted, with the done class newest-first, which is what makes the
 * "keep the first N read rows" rule mean "keep the newest N".
 *
 * @param {readonly {
 *   key: string,
 *   title: string,
 *   cwd: string,
 *   running: number,
 *   unread: number,
 *   rows: SidebarRow[],
 * }[]} groups
 * @param {number} capacity lines available to the grouped list (headers included)
 * @param {string} currentId
 * @returns {{
 *   groups: any[],
 *   flatRows: SidebarRow[],
 *   doneCap: number,
 *   hidden: number,
 *   total: number,
 *   overflow: boolean,
 * }}
 */
export function fitGroups(groups, capacity, currentId) {
  const source = Array.isArray(groups) ? groups : [];
  const current = String(currentId ?? '');
  const base = source.map(group => ({
    ...group,
    rows: Array.isArray(group.rows) ? group.rows : [],
  }));
  const countOf = list => list.reduce((total, group) => total + 1 + group.rows.length, 0);
  const baseTotal = countOf(base);
  const budget = Number.isFinite(capacity) ? Math.floor(capacity) : 0;

  if (budget <= 0 || baseTotal <= budget) {
    return {
      groups: base,
      flatRows: base.flatMap(group => group.rows),
      doneCap: DONE_ROWS_PER_PROJECT,
      hidden: 0,
      total: baseTotal,
      overflow: false,
    };
  }

  let best = base;
  let bestTotal = baseTotal;
  let bestCap = DONE_ROWS_PER_PROJECT;
  for (let cap = DONE_ROWS_PER_PROJECT - 1; cap >= MIN_DONE_ROWS_PER_PROJECT; cap -= 1) {
    const candidate = base.map(group => ({
      ...group,
      rows: capDoneRows(group.rows, current, cap),
    }));
    const candidateTotal = countOf(candidate);
    // No project has more than `cap` read rows, so a smaller cap cannot help.
    if (candidateTotal === bestTotal) break;
    best = candidate;
    bestTotal = candidateTotal;
    bestCap = cap;
    if (bestTotal <= budget) break;
  }

  return {
    groups: best,
    flatRows: best.flatMap(group => group.rows),
    doneCap: bestCap,
    hidden: baseTotal - bestTotal,
    total: bestTotal,
    overflow: bestTotal > budget,
  };
}

/**
 * Which row the panel highlights.
 *
 * The explicit selection wins while the person is navigating; otherwise the
 * attached conversation is chosen, and only when it is not listed at all does
 * the list fall back to its first row. This is what makes the panel open with
 * the highlight on the conversation actually on screen.
 *
 * @param {readonly SidebarRow[]} rows
 * @param {string | null | undefined} selectedId
 * @param {string | undefined} currentId
 * @returns {SidebarRow | undefined}
 */
export function selectedRow(rows, selectedId, currentId) {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  if (selectedId !== null && selectedId !== undefined && selectedId !== '') {
    const explicit = rows.find(row => row?.id === selectedId);
    if (explicit !== undefined) return explicit;
  }
  const current = String(currentId ?? '');
  if (current !== '') {
    const attached = rows.find(row => row?.id === current);
    if (attached !== undefined) return attached;
  }
  return rows[0];
}

/**
 * The chat's spinner for a given animation frame.
 *
 * The row glyph and the project counter go through this helper, so they spin
 * in lockstep and a hard-coded first frame cannot creep back in. The header
 * total is plain text and deliberately does not use it. Junk frames (NaN,
 * negative, huge) settle on a valid frame instead of rendering `undefined`.
 *
 * @param {number} frame
 * @returns {string}
 */
export function spinnerGlyph(frame) {
  const index = Number.isFinite(frame) ? Math.abs(Math.floor(frame)) % RUNNING_FRAMES.length : 0;
  return RUNNING_FRAMES[index];
}

/**
 * The inbox's glyph vocabulary, shared with the old full-screen inbox:
 * the chat's own spinner while running; a solid dot for a finished turn nobody
 * has looked at yet; the dimmed checkmark once it has been read; a cross for a
 * failed turn (also dimmed once read).
 *
 * A parked background question borrows the finished-unread dot, even while its
 * turn is still running: it is the same "someone is waiting for you" signal,
 * and it is the one attention glyph the person already knows. The row text
 * carries the distinction (`待回答` / `needs you`), not a second glyph.
 *
 * A running plan-mode conversation keeps the same spinner character and dim
 * state but borrows the theme's plan colour, so the row says "this turn is
 * planning" without a second glyph. Only row glyphs take that colour: the
 * project counter always shows the normal running colour ({@link counterGlyph}),
 * because it aggregates every running conversation in the workspace.
 *
 * @param {SidebarRow} row
 * @param {number} frame
 * @returns {{char: string, color: string | undefined, dim: boolean}}
 */
export function glyphFor(row, frame) {
  if (isWaiting(row)) {
    return { char: '●', color: 'success', dim: false };
  }
  if (row?.status === 'running') {
    return {
      char: spinnerGlyph(frame),
      color: row.plan === true ? 'planMode' : 'suggestion',
      dim: false,
    };
  }
  if (!isUnread(row)) {
    return row?.failed
      ? { char: '✕', color: 'error', dim: true }
      : { char: '✓', color: 'success', dim: true };
  }
  if (row?.failed) return { char: '✕', color: 'error', dim: false };
  return { char: '●', color: 'success', dim: false };
}

/**
 * The status character a project header shows for one state.
 *
 * A project counter is not a count any more: it reuses the row glyph's
 * character, so the folder icon turns in lockstep with the conversation icons.
 * The header keeps its own muted chrome style — no row colour, no numbers; the
 * counts live in the panel's header total.
 *
 * `'running'` uses the plain running frame; a plan-mode row's sage colour stays
 * on that row only, because the counter aggregates turns, not modes.
 * `'unread'` uses the finished-unread dot. Both delegate to {@link glyphFor},
 * so the characters cannot drift apart.
 *
 * @param {'running' | 'unread'} kind
 * @param {number} frame
 * @returns {string}
 */
export function counterGlyph(kind, frame) {
  if (kind === 'unread') {
    return glyphFor({ status: 'finished', failed: false, finishedAt: 1, seenAt: 0 }, frame).char;
  }
  return glyphFor({ status: 'running' }, frame).char;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function timeOf(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return 0;
  // Sessions written before 2001 are clock bugs, not history.
  if (time < 1e12) return time > 1e9 ? time * 1000 : 0;
  return time;
}

/**
 * @param {number} at
 * @param {number} now
 * @param {'zh' | 'en'} lang
 * @returns {string}
 */
export function formatWhen(at, now, lang) {
  const time = timeOf(at);
  if (time === 0) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const zh = lang === 'zh';
  if (seconds < 45) return zh ? '刚刚' : 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return zh ? `${days} 天前` : `${days}d ago`;
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * First visible item that keeps `focus` on screen.
 * @param {number} total
 * @param {number} focus
 * @param {number} capacity
 * @returns {number}
 */
export function windowTop(total, focus, capacity) {
  if (total <= capacity || capacity <= 0) return 0;
  const maxTop = total - capacity;
  const half = Math.floor(capacity / 2);
  return Math.max(0, Math.min(maxTop, focus - half));
}
