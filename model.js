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
export const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;

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
 * @returns {{count: number, title: string, prompt: string, summary: string, updatedAt: number, failed: boolean}}
 */
export function emptyFold() {
  return { count: 0, title: '', prompt: '', summary: '', updatedAt: 0, failed: false };
}

/**
 * Fold new session events into a previously folded state.
 *
 * `fromIndex` is the number of events already folded; only the tail is read, so
 * a running session's whole log is not re-scanned on every status change.
 *
 * @param {readonly unknown[]} events
 * @param {number} fromIndex
 * @param {{count: number, title: string, prompt: string, summary: string, updatedAt: number, failed: boolean}} state
 * @returns {{state: {count: number, title: string, prompt: string, summary: string, updatedAt: number, failed: boolean}, count: number}}
 */
export function foldAgentEvents(events, fromIndex, state) {
  const input = Array.isArray(events) ? events : [];
  const start = Number.isFinite(fromIndex) && fromIndex >= 0 ? Math.min(Math.floor(fromIndex), input.length) : 0;
  let { title, prompt, summary, updatedAt, failed } = state;
  for (let index = start; index < input.length; index += 1) {
    const event = input[index];
    if (!event || typeof event !== 'object') continue;
    const time = Number(event.time);
    if (Number.isFinite(time) && time > 0) updatedAt = Math.max(updatedAt, time);
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    switch (event.type) {
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
  return { state: { count: input.length, title, prompt, summary, updatedAt, failed }, count: input.length };
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
 * Last moment anything happened in a row. The finish marker can be observed a
 * moment after the final event, so the later of the two wins.
 * @param {{updatedAt?: number, finishedAt?: number}} row
 * @returns {number}
 */
export function activityAt(row) {
  if (!row || typeof row !== 'object') return 0;
  return Math.max(Number(row.updatedAt) || 0, Number(row.finishedAt) || 0);
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
 * @param {any} prev
 * @param {{
 *   id: string,
 *   cwd: string,
 *   title: string,
 *   running: boolean,
 *   failed?: boolean,
 *   updatedAt: number,
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
    return {
      id,
      cwd,
      title,
      status: 'running',
      failed: Boolean(input.failed),
      updatedAt,
      finishedAt: 0,
      seenAt: Number(prev?.seenAt) || 0,
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
      updatedAt: updatedAt || finishedAt,
      finishedAt,
      // A session the person is actively looking at settles as read: a badge
      // for the conversation already on screen would be pure noise.
      seenAt: isCurrent ? finishedAt : Number(prev.seenAt) || 0,
    };
  }

  if (prev === undefined) {
    if (!isCurrent) return undefined;
    // The attached session is worth listing even when nothing is running: it
    // is where the person is, and it is the row the panel highlights. It is
    // adopted as read — nothing was missed while it was on screen.
    const finishedAt = updatedAt > 0 ? updatedAt : (Number(input.now) || Date.now());
    return {
      id,
      cwd,
      title,
      status: 'finished',
      failed: Boolean(input.failed),
      updatedAt: finishedAt,
      finishedAt,
      seenAt: finishedAt,
    };
  }

  const finishedAt = Number(prev.finishedAt) || 0;
  const next = {
    id,
    cwd,
    title,
    status: prev.status === 'finished' ? 'finished' : prev.status,
    failed: input.failed === undefined ? Boolean(prev.failed) : Boolean(input.failed),
    updatedAt: Math.max(Number(prev.updatedAt) || 0, updatedAt),
    finishedAt,
    seenAt: Number(prev.seenAt) || 0,
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
    .filter(([id, row]) => row?.status === 'finished' && id !== view.currentId)
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
    if (current !== '' && id === current) continue;
    const at = activityAt(row) + retention;
    if (earliest === 0 || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * @typedef {{id: string, cwd: string, title: string, status: string, failed: boolean, updatedAt: number, finishedAt: number, seenAt: number}} SidebarRow
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
 * Newest activity first — the same value the row prints on its right — with a
 * running row winning a timestamp tie so a just-started conversation is not
 * buried under a just-finished one.
 * @param {SidebarRow} left
 * @param {SidebarRow} right
 * @returns {number}
 */
function compareByActivity(left, right) {
  const leftAt = Number(left.updatedAt) || 0;
  const rightAt = Number(right.updatedAt) || 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  const leftRunning = left.status === 'running' ? 0 : 1;
  const rightRunning = right.status === 'running' ? 0 : 1;
  if (leftRunning !== rightRunning) return leftRunning - rightRunning;
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

/**
 * Group visible rows by project, newest activity first inside each project.
 * Projects themselves keep the old ordering: a project with something running
 * leads, then by its freshest row.
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
    const list = [...bucket.rows].sort(compareByActivity);
    let running = 0;
    let unread = 0;
    for (const row of list) {
      if (row.status === 'running') running += 1;
      else if (isUnread(row) && String(row.id) !== current) unread += 1;
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
    };
  });

  projects.sort((left, right) => {
    const leftRunning = left.running > 0 ? 0 : 1;
    const rightRunning = right.running > 0 ? 0 : 1;
    if (leftRunning !== rightRunning) return leftRunning - rightRunning;
    const leftNewest = left.rows.length > 0 ? Number(left.rows[0].updatedAt) || 0 : 0;
    const rightNewest = right.rows.length > 0 ? Number(right.rows[0].updatedAt) || 0 : 0;
    if (leftNewest !== rightNewest) return rightNewest - leftNewest;
    return left.order - right.order;
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
    groups: projects.map(({ order: _order, ...rest }) => rest),
    running,
    unread,
    flatRows,
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
 * Every place that counts a running turn — the row glyph, the project counter
 * and the header — goes through this helper, so they spin in lockstep and a
 * hard-coded first frame cannot creep back in. Junk frames (NaN, negative,
 * huge) settle on a valid frame instead of rendering `undefined`.
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
 * @param {SidebarRow} row
 * @param {number} frame
 * @returns {{char: string, color: string | undefined, dim: boolean}}
 */
export function glyphFor(row, frame) {
  if (row?.status === 'running') {
    return { char: spinnerGlyph(frame), color: 'suggestion', dim: false };
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
