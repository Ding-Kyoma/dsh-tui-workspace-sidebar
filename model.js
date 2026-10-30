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

/** One finished entry older than this is pruned even when still unread. */
export const MAX_FINISHED_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
 * The one transition table for a tracked row.
 *
 * `prev` is the row currently tracked (or undefined). The return value is the
 * next row, or undefined when the row should no longer exist. The caller keeps
 * rows that are `running` or finished-and-unread; anything else is dropped.
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

  if (prev === undefined) return undefined;

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
 * Drop rows nobody can act on any more: finished-but-read entries are removed
 * elsewhere, so this only bounds the finished tail (oldest first).
 *
 * @param {Map<string, any>} rows mutated in place
 * @param {number} max
 * @param {number} now
 * @returns {number} how many rows were removed
 */
export function pruneRows(rows, max, now) {
  if (!(rows instanceof Map)) return 0;
  let removed = 0;
  for (const [id, row] of rows) {
    if (row?.status !== 'finished') continue;
    if (Number(now) - Number(row.finishedAt) > MAX_FINISHED_AGE_MS) {
      rows.delete(id);
      removed += 1;
    }
  }
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 300;
  if (rows.size <= limit) return removed;
  const finished = [...rows.entries()]
    .filter(([, row]) => row?.status === 'finished')
    .sort((left, right) => (Number(left[1].finishedAt) || 0) - (Number(right[1].finishedAt) || 0));
  while (rows.size > limit && finished.length > 0) {
    const [id] = finished.shift();
    rows.delete(id);
    removed += 1;
  }
  return removed;
}

/**
 * @typedef {{id: string, cwd: string, title: string, status: string, failed: boolean, updatedAt: number, finishedAt: number, seenAt: number}} SidebarRow
 */

/**
 * Rows the sidebar is allowed to show, in no particular order.
 * @param {readonly SidebarRow[]} rows
 * @param {string} currentId
 * @returns {SidebarRow[]}
 */
export function visibleRows(rows, currentId) {
  const current = String(currentId ?? '');
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (current !== '' && String(row.id) === current) continue;
    if (row.status === 'running' || isUnread(row)) out.push(row);
  }
  return out;
}

/**
 * Group visible rows by project and sort them the way a triage list wants:
 * anything running first, then the freshest unread conversation.
 *
 * @param {readonly SidebarRow[]} rows
 * @param {readonly {path?: string, title?: string}[]} registry
 * @param {string} currentId
 * @returns {{
 *   groups: {key: string, title: string, cwd: string, running: number, unread: number, rows: SidebarRow[]}[],
 *   running: number,
 *   unread: number,
 *   flatRows: SidebarRow[],
 * }}
 */
export function buildGroups(rows, registry, currentId) {
  const visible = visibleRows(rows, currentId);
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
    const list = [...bucket.rows].sort((left, right) => {
      const leftRunning = left.status === 'running' ? 0 : 1;
      const rightRunning = right.status === 'running' ? 0 : 1;
      if (leftRunning !== rightRunning) return leftRunning - rightRunning;
      return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
    });
    let running = 0;
    let unread = 0;
    for (const row of list) {
      if (row.status === 'running') running += 1;
      else if (isUnread(row)) unread += 1;
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
 * @param {SidebarRow} row
 * @param {number} frame
 * @returns {{char: string, color: string | undefined, dim: boolean}}
 */
export function glyphFor(row, frame) {
  if (row?.status === 'running') {
    const index = Number.isFinite(frame) ? Math.abs(Math.floor(frame)) % RUNNING_FRAMES.length : 0;
    return { char: RUNNING_FRAMES[index], color: 'suggestion', dim: false };
  }
  if (row?.failed) return { char: '✕', color: 'error', dim: false };
  return { char: '✓', color: 'success', dim: false };
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
