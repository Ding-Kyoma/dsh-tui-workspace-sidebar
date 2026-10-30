/**
 * Durable state for the workspace sidebar.
 *
 * The sidebar is a triage surface, not a second session store: it remembers
 * only the conversations that are running or finished-but-unread, plus the
 * title/cwd needed to render them after a restart. Writes are debounced and
 * atomic; a corrupt file is preserved next to the original instead of being
 * silently overwritten.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;
export const DEFAULT_STATE_FILE = join(homedir(), '.dsh-tui', 'workspace-sidebar.json');
const WRITE_DELAY_MS = 400;

/**
 * Expand a leading `~` without touching process.cwd().
 * @param {string} file
 * @returns {string}
 */
export function expandHome(file) {
  const value = typeof file === 'string' ? file.trim() : '';
  if (value === '' || value === '~') return value === '~' ? homedir() : DEFAULT_STATE_FILE;
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * @param {unknown} raw
 * @returns {{version: number, sessions: Record<string, any>}}
 */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const input = source.sessions && typeof source.sessions === 'object' ? source.sessions : {};
  /** @type {Record<string, any>} */
  const sessions = {};
  for (const [id, value] of Object.entries(input)) {
    if (typeof id !== 'string' || id === '') continue;
    if (!value || typeof value !== 'object') continue;
    const status = value.status === 'running' ? 'running' : value.status === 'finished' ? 'finished' : '';
    if (status === '') continue;
    const record = {
      id,
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      title: typeof value.title === 'string' ? value.title : '',
      status,
      failed: value.failed === true,
      updatedAt: numberOrZero(value.updatedAt),
      finishedAt: numberOrZero(value.finishedAt),
      seenAt: numberOrZero(value.seenAt),
    };
    sessions[id] = record;
  }
  return { version: STATE_VERSION, sessions };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * @param {string} path
 * @param {unknown} error
 * @param {{warn?: (message: string) => void} | undefined} logger
 */
function warn(path, error, logger) {
  try {
    logger?.warn?.(`workspace-sidebar: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } catch {
    // Logging must never break the sidebar.
  }
}

/**
 * @param {{
 *   file?: string,
 *   logger?: {warn?: (message: string) => void},
 *   now?: () => number,
 * }} [options]
 */
export function createStore(options = {}) {
  const file = expandHome(options.file ?? DEFAULT_STATE_FILE);
  const logger = options.logger;
  const clock = typeof options.now === 'function' ? options.now : Date.now;

  /** @type {{version: number, sessions: Record<string, any>}} */
  let state = normalizeState(undefined);
  let loaded = false;
  let loadPromise;
  let revision = 0;
  let dirty = false;
  let timer;
  let writeChain = Promise.resolve();
  let tempSeq = 0;
  const subscribers = new Set();

  function emit() {
    revision += 1;
    for (const listener of subscribers) {
      try {
        listener();
      } catch {
        // A render subscriber must not break persistence.
      }
    }
  }

  function subscribe(listener) {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function getVersion() {
    return revision;
  }

  function isLoaded() {
    return loaded;
  }

  async function quarantine(error) {
    try {
      const target = `${file}.corrupt-${clock()}`;
      await rename(file, target);
      warn(file, `unreadable state preserved at ${target}: ${error instanceof Error ? error.message : String(error)}`, logger);
    } catch (renameError) {
      warn(file, renameError, logger);
    }
  }

  async function load() {
    if (loaded) return state;
    if (loadPromise !== undefined) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await readFile(file, 'utf8');
        try {
          state = normalizeState(JSON.parse(raw));
        } catch (error) {
          await quarantine(error);
          state = normalizeState(undefined);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          warn(file, error, logger);
        }
        state = normalizeState(undefined);
      }
      loaded = true;
      emit();
      return state;
    })();
    return loadPromise;
  }

  async function writeOnce() {
    if (!dirty) return;
    dirty = false;
    const payload = JSON.stringify(state, null, 2);
    const temporary = `${file}.tmp-${process.pid}-${tempSeq++}`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        await chmod(temporary, 0o600);
      } catch {
        // chmod is not portable everywhere; the mode above is best-effort.
      }
      await rename(temporary, file);
    } catch (error) {
      dirty = true;
      try {
        await rm(temporary, { force: true });
      } catch {
        // The temp file is a best-effort cleanup.
      }
      warn(file, error, logger);
    }
  }

  function schedule() {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      writeChain = writeChain.then(writeOnce, writeOnce);
    }, WRITE_DELAY_MS);
    // A pending flush must not keep the process (or a quit) alive.
    timer.unref?.();
  }

  /**
   * Replace the persisted session map. The caller owns the shape; it is copied
   * so later mutations of the tracker's Map cannot leak into the file.
   * @param {Record<string, any>} sessions
   */
  function save(sessions) {
    const next = {};
    if (sessions && typeof sessions === 'object') {
      for (const [id, row] of Object.entries(sessions)) {
        if (typeof id !== 'string' || id === '' || !row || typeof row !== 'object') continue;
        next[id] = {
          id,
          cwd: typeof row.cwd === 'string' ? row.cwd : '',
          title: typeof row.title === 'string' ? row.title : '',
          status: row.status === 'running' ? 'running' : 'finished',
          failed: row.failed === true,
          updatedAt: numberOrZero(row.updatedAt),
          finishedAt: numberOrZero(row.finishedAt),
          seenAt: numberOrZero(row.seenAt),
        };
      }
    }
    state = { version: STATE_VERSION, sessions: next };
    dirty = true;
    schedule();
    emit();
  }

  /** @returns {{version: number, sessions: Record<string, any>}} */
  function snapshot() {
    return state;
  }

  async function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    writeChain = writeChain.then(writeOnce, writeOnce);
    await writeChain;
  }

  async function close() {
    await flush();
  }

  return { file, load, ready: load, save, snapshot, flush, close, subscribe, getVersion, isLoaded };
}
