/**
 * Clipboard plumbing for the workspace sidebar.
 *
 * Clicking a folder's copy icon puts that workspace's absolute path on the
 * system clipboard. dsh-tui already owns a clipboard implementation — the same
 * one a mouse selection uses — but it is not part of the plugin package
 * surface: there is no `tuiClipboard` service, no host API method and no
 * exported subpath for it. The module lives in the host package as
 * `lib/types/ink/termio/osc.js`, and its `setClipboard(text)` writes the native
 * clipboard (pbcopy / clip / wl-copy / xclip / xsel), loads the tmux buffer and
 * returns the OSC 52 sequence the *caller* is expected to write to stdout.
 *
 * So the host code is reused as-is, located at runtime and imported by absolute
 * file URL (the package `exports` map does not expose it). The running dsh
 * process hands the plugins their profile location, which is how the copy is
 * resolved even for a `link:` development install whose real path lives outside
 * the profile's `node_modules`.
 *
 * Everything is feature-detected and fail-open, like the rest of the plugin: if
 * a future dsh-tui moves that internal file, a self-contained fallback (native
 * tool + our own OSC 52 sequence) keeps the icon working, and an unavailable
 * clipboard turns into a toast instead of a broken panel.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How long the "path copied" confirmation stays on screen. */
export const COPY_TOAST_MS = 3000;

/** Host package whose clipboard writer is reused. */
export const HOST_PACKAGE = '@deepseek-harness-tui/dsh-tui';

/** The host module that implements the clipboard write (not an export). */
export const HOST_CLIPBOARD_SUBPATH = 'lib/types/ink/termio/osc.js';

/** OSC 52 selects the clipboard (`c`) rather than the primary selection. */
const CLIPBOARD_PREFIX = '\x1b]52;c;';

/** BEL terminates the sequence; every terminal that knows OSC 52 accepts it. */
const CLIPBOARD_TERMINATOR = '\x07';

/** A clipboard helper that hangs must not hold the click handler forever. */
const NATIVE_TIMEOUT_MS = 2000;

/**
 * Native clipboard helpers per platform, in probe order.
 *
 * The host uses the same order (wl-copy before the X11 tools) and skips all of
 * them over SSH: a remote machine's clipboard is not where the person pastes.
 *
 * @type {Readonly<Record<string, readonly (readonly [string, readonly string[]])[]>>}
 */
const NATIVE_COMMANDS = Object.freeze({
  darwin: [['pbcopy', []]],
  win32: [['clip', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ],
});

/**
 * Candidate paths for the host's clipboard module, best first.
 *
 * 1. The profile the running TUI was started from — `dsh` exports
 *    `DSH_PROFILE_DIR`, and the copy of dsh-tui that is actually executing is
 *    the one installed there. This also covers a linked plugin, whose real
 *    path is outside the profile.
 * 2. `DSH_HOME` + `DSH_PROFILE`, for a host that only sets the older pair.
 * 3. Normal package resolution, which covers a plugin installed inside the
 *    profile's own `node_modules`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function hostClipboardCandidates(env = process.env) {
  const candidates = [];
  const profileDir = typeof env?.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  if (profileDir !== '') candidates.push(join(profileDir, 'node_modules', ...HOST_PACKAGE.split('/'), HOST_CLIPBOARD_SUBPATH));

  const home = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (home !== '') {
    const profile = typeof env?.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== ''
      ? env.DSH_PROFILE.trim()
      : 'dsh-tui';
    candidates.push(join(home, 'profiles', profile, 'node_modules', ...HOST_PACKAGE.split('/'), HOST_CLIPBOARD_SUBPATH));
  }

  try {
    // `./package.json` is an exported subpath, so this resolves for a normal
    // install and throws for a linked one; the two guesses above cover that.
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${HOST_PACKAGE}/package.json`);
    candidates.push(join(dirname(manifest), HOST_CLIPBOARD_SUBPATH));
  } catch {
    // No resolvable host package: keep the guesses.
  }

  return [...new Set(candidates)];
}

/**
 * Load the host's clipboard module from the first candidate that exists.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(specifier: string) => Promise<any>} [importModule]
 * @param {(path: string) => boolean} [exists]
 * @returns {Promise<{setClipboard: (text: string) => Promise<string>} | undefined>}
 */
export async function loadHostClipboard(env = process.env, importModule = specifier => import(specifier), exists = existsSync) {
  for (const candidate of hostClipboardCandidates(env)) {
    try {
      if (!exists(candidate)) continue;
    } catch {
      continue;
    }
    try {
      const module = await importModule(pathToFileURL(candidate).href);
      if (module && typeof module.setClipboard === 'function') return module;
    } catch {
      // A moved or incompatible file is a fallback, not a failure.
    }
  }
  return undefined;
}

/**
 * The OSC 52 sequence that puts `text` on the clipboard.
 *
 * Exported so the fallback can be asserted character for character: it is the
 * one piece of the write that is ours rather than the host's.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function clipboardSequence(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return `${CLIPBOARD_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}${CLIPBOARD_TERMINATOR}`;
}

/**
 * Feed `text` to one clipboard helper and answer whether it exited cleanly.
 *
 * `execFile` has no `input` option (that is the sync variant), so the text goes
 * through stdin by hand. Errors are swallowed: a missing helper is an ordinary
 * miss, not an exception the panel has to handle.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {string} text
 * @returns {Promise<boolean>}
 */
function runNative(file, args, text) {
  return new Promise(resolve => {
    let settled = false;
    /** @param {boolean} ok */
    const done = ok => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = execFile(file, [...args], { timeout: NATIVE_TIMEOUT_MS, windowsHide: true }, error => done(!error));
      child?.on?.('error', () => done(false));
      if (child?.stdin) {
        child.stdin.on('error', () => done(false));
        child.stdin.end(text);
      }
    } catch {
      done(false);
    }
  });
}

/**
 * A clipboard writer bound to one activation.
 *
 * Both the host module and the runners are injectable so the failure matrix is
 * testable without touching a real clipboard or spawning a process.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   stdout?: {write: (chunk: string) => unknown},
 *   loadHost?: (env: Record<string, string | undefined>) => Promise<any>,
 *   run?: (file: string, args: readonly string[], text: string) => Promise<boolean>,
 * }} [options]
 * @returns {{copy: (value: unknown) => Promise<{ok: boolean, via: 'host' | 'native' | 'osc52' | 'none', reason?: string}>}}
 */
export function createClipboard(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const stdout = options.stdout ?? process.stdout;
  const run = typeof options.run === 'function' ? options.run : runNative;
  const loadHost = typeof options.loadHost === 'function'
    ? options.loadHost
    : target => loadHostClipboard(target);

  // The host module is loaded on the first copy, not at activation: a panel
  // that is never clicked must not pull host internals into the plugin.
  let hostPromise;
  function host() {
    if (hostPromise === undefined) {
      hostPromise = Promise.resolve()
        .then(() => loadHost(env))
        .catch(() => undefined);
    }
    return hostPromise;
  }

  /** @param {string} sequence */
  function write(sequence) {
    if (typeof sequence !== 'string' || sequence === '') return false;
    try {
      stdout.write(sequence);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} text
   * @returns {Promise<{ok: boolean, via: 'host'} | undefined>}
   */
  async function copyThroughHost(text) {
    const module = await host();
    if (!module || typeof module.setClipboard !== 'function') return undefined;
    try {
      const raw = await module.setClipboard(text);
      // The host already wrote the native clipboard and the tmux buffer; the
      // returned sequence is ours to emit (that is what its own mouse-selection
      // copy does through Ink's writeRaw).
      write(raw);
      return { ok: true, via: 'host' };
    } catch {
      return undefined;
    }
  }

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copyNative(text) {
    // Over SSH these helpers would target the remote machine's clipboard; the
    // OSC 52 sequence is the path that reaches the terminal instead.
    if (typeof env?.SSH_CONNECTION === 'string' && env.SSH_CONNECTION !== '') return false;
    const commands = NATIVE_COMMANDS[platform] ?? [];
    for (const [file, args] of commands) {
      if (await run(file, args, text)) return true;
    }
    return false;
  }

  return {
    /**
     * @param {unknown} value
     * @returns {Promise<{ok: boolean, via: 'host' | 'native' | 'osc52' | 'none', reason?: string}>}
     */
    async copy(value) {
      const text = typeof value === 'string' ? value : String(value ?? '');
      if (text === '') return { ok: false, via: 'none', reason: 'empty' };

      const hosted = await copyThroughHost(text);
      if (hosted !== undefined) return hosted;

      // Fallback for a host whose module moved: the same two mechanisms the
      // host uses, without its tmux-buffer step.
      const wrote = write(clipboardSequence(text));
      const native = await copyNative(text);
      if (native) return { ok: true, via: 'native' };
      if (wrote) return { ok: true, via: 'osc52' };
      return { ok: false, via: 'none', reason: 'unavailable' };
    },
  };
}
