/**
 * Which session is the attached one?
 *
 * Plugin panels do not receive a channel, and `host.snapshot()` is only
 * available while the panel is mounted. The editor-injection discovery file is
 * the one documented, cross-process signal that names the session a TUI process
 * currently serves: one record per live injection server, keyed by pid.
 *
 * This is a best-effort probe. A missing or half-written file (the writer
 * rewrites it in place) simply means "unknown"; the panel corrects the answer
 * from `host.snapshot()` as soon as it renders.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SERVERS_FILE = join(homedir(), '.dsh-tui', 'inject', 'servers.json');

/**
 * @param {{file?: string, pid?: number}} [options]
 * @returns {string | undefined}
 */
export function readAttachedSessionId(options = {}) {
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : DEFAULT_SERVERS_FILE;
  const pid = Number.isFinite(options.pid) ? options.pid : process.pid;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.pid !== pid) continue;
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue;
    return entry.sessionId;
  }
  return undefined;
}
