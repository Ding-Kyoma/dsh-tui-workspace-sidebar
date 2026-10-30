/**
 * Background question relay.
 *
 * dsh-user-questions dispatches every ask on the `user-questions/request`
 * waterfall, scoped to the asking agent. dsh-tui's answerer only claims the
 * request when the agent is the channel's attached session
 * (`String(request.agent.id) === owner.agentId`); a background session calls
 * `next()` and the chain ends in `NO_PROVIDER`, which surfaces as a failed
 * `ask_user_question` / `exit_plan_mode` tool call.
 *
 * This module is a *fallback* answerer, deliberately at the end of the chain:
 *
 * 1. it calls `next()` first, so the host (or any other answerer) always gets
 *    the first chance to handle the ask;
 * 2. it only takes over when the chain rejects with `NO_PROVIDER` and the agent
 *    is not the attached session — a foreground failure is never masked;
 * 3. instead of answering, it parks the request, marks the sidebar row as
 *    waiting (the same green dot as a finished-unread row), and keeps the
 *    original promise pending;
 * 4. the question is re-dispatched only when the person opens that row in the
 *    inbox: the jump scene calls `deliver(agentId)` after the channel adopts the
 *    session. The relay never watches the attached session to decide delivery,
 *    so a background question cannot pop up in the conversation the person is
 *    currently using. The green dot is the only advance notice, and the jump is
 *    the explicit "handle this now" action.
 *
 * The design is intentionally decoupled from the host's fix for the same bug:
 * the relay always yields with `next()` and only acts on `NO_PROVIDER`, so once
 * dsh-tui starts handling background questions itself this module simply never
 * parks anything. `relayQuestions: false` disables it entirely.
 */

/**
 * Marks a request re-dispatched by this relay. Object spread copies enumerable
 * symbol properties, so the marker survives `UserQuestionService.ask()`'s
 * `{ ...request, agent }` and our own listener can pass the request straight to
 * `next()` instead of parking it a second time.
 */
const FORWARD = Symbol('workspace-sidebar.forward');

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * The specific rejection dsh-user-questions uses when no answerer claimed the
 * request. It is the only error this relay is allowed to convert into a parked
 * question; every other rejection keeps its normal meaning.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isNoProvider(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'NO_PROVIDER';
}

/**
 * A user cancellation or an aborted turn is a real settlement, not a transient
 * failure: the original caller must see it so plan mode can keep planning and
 * a cancelled tool call can fail normally.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isInterruption(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === 'ASK_CANCELLED' || error.code === 'ASK_ABORTED';
}

/**
 * Build the error shape `restoreUserQuestionError()` understands, without
 * importing `@deepseek-ai/dsh-user-questions` (the plugin must keep working
 * when that package is absent or has a different minor version).
 *
 * @param {string} message
 * @param {'ASK_ABORTED' | 'ASK_CANCELLED'} code
 * @returns {Error}
 */
function questionError(message, code) {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}

/**
 * @param {any} request
 * @returns {string}
 */
function agentIdOf(request) {
  const id = request?.agent?.id;
  return typeof id === 'string' ? id : String(id ?? '');
}

/**
 * @param {{
 *   ctx?: any,
 *   tracker?: any,
 *   probe?: () => string | undefined,
 *   logger?: {warn?: (message: string) => void},
 *   service?: any,
 * }} [options]
 */
export function createQuestionRelay(options = {}) {
  const { ctx, tracker, probe, logger } = options;

  let service = options.service;
  let disposed = false;
  const disposers = [];
  /** @type {Map<string, any[]>} */
  const parked = new Map();

  /**
   * @param {string} message
   * @param {unknown} [error]
   */
  function warn(message, error) {
    try {
      const tail = error === undefined ? '' : `: ${messageOf(error)}`;
      logger?.warn?.(`workspace-sidebar: ${message}${tail}`);
    } catch {
      // Logging must never break the relay.
    }
  }

  /**
   * Resolve the live user-questions service. `ctx.get` is checked on every use
   * so a service replaced by an HMR reload is not cached forever; the injected
   * fallback only covers a late mount.
   *
   * @returns {any}
   */
  function resolveService() {
    let current;
    try {
      current = typeof ctx?.get === 'function' ? ctx.get('userQuestions', false) : undefined;
    } catch (error) {
      warn('reading userQuestions failed', error);
    }
    if (current && typeof current.ask === 'function') {
      service = current;
      return current;
    }
    return service && typeof service.ask === 'function' ? service : undefined;
  }

  /**
   * @returns {string}
   */
  function readProbe() {
    if (typeof probe !== 'function') return '';
    try {
      const id = probe();
      return typeof id === 'string' ? id : '';
    } catch (error) {
      warn('reading the attached session failed', error);
      return '';
    }
  }

  /**
   * @returns {string}
   */
  function readTracked() {
    if (typeof tracker?.getCurrentId !== 'function') return '';
    try {
      const id = tracker.getCurrentId();
      return typeof id === 'string' ? id : '';
    } catch {
      return '';
    }
  }

  /**
   * Whether an ask is for the conversation the TUI is already showing. The
   * probe is authoritative; the tracker is the fallback when the probe file is
   * unavailable. A foreground `NO_PROVIDER` is a host bug, not a background
   * question, so the relay must not swallow it.
   *
   * @param {string} agentId
   * @returns {boolean}
   */
  function isAttached(agentId) {
    const probed = readProbe();
    if (probed !== '') return probed === agentId;
    const tracked = readTracked();
    return tracked !== '' && tracked === agentId;
  }

  /**
   * @param {any} entry
   */
  function removeEntry(entry) {
    const list = parked.get(entry.agentId);
    if (list === undefined) return;
    const next = list.filter(item => item !== entry);
    if (next.length === 0) parked.delete(entry.agentId);
    else parked.set(entry.agentId, next);
  }

  /**
   * Keep the tracker's attention flag in sync with the queue. The queue is the
   * source of truth: several asks for one agent keep the row green until the
   * last one settles.
   *
   * @param {string} agentId
   */
  function updateWaiting(agentId) {
    try {
      tracker?.setWaiting?.(agentId, parked.has(agentId));
    } catch (error) {
      warn('updating the waiting flag failed', error);
    }
  }

  /**
   * @param {any} entry
   * @param {unknown} [error]
   * @param {any} [answer]
   */
  function settle(entry, error, answer) {
    if (entry.settled) return;
    entry.settled = true;
    const signal = entry.request?.signal;
    if (entry.onAbort && signal && typeof signal.removeEventListener === 'function') {
      try {
        signal.removeEventListener('abort', entry.onAbort);
      } catch {
        // A torn-down signal is not worth failing a settlement over.
      }
    }
    entry.onAbort = undefined;
    removeEntry(entry);
    if (error !== undefined) entry.reject(error);
    else entry.resolve(answer);
    updateWaiting(entry.agentId);
  }

  /**
   * Park a request that no answerer claimed. The returned promise is what the
   * original `UserQuestionService.ask()` call is waiting on; it resolves with
   * the answer once the person opens the row and answers the re-dispatched
   * question.
   *
   * @param {any} request
   * @returns {Promise<any>}
   */
  function park(request) {
    if (disposed) {
      return Promise.reject(questionError(
        'the background question relay was disposed before the user answered',
        'ASK_ABORTED',
      ));
    }
    const agentId = agentIdOf(request);
    const entry = {
      request,
      agentId,
      resolve: undefined,
      reject: undefined,
      settled: false,
      forwarding: false,
      warned: false,
      onAbort: undefined,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    const list = parked.get(agentId);
    if (list === undefined) parked.set(agentId, [entry]);
    else list.push(entry);

    const signal = request?.signal;
    if (signal && typeof signal.addEventListener === 'function') {
      entry.onAbort = () => {
        settle(entry, questionError(
          'the background question was interrupted before the user answered',
          'ASK_ABORTED',
        ));
      };
      if (signal.aborted) queueMicrotask(entry.onAbort);
      else signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    updateWaiting(agentId);
    return promise;
  }

  /**
   * @param {any} entry
   */
  function forward(entry) {
    const current = resolveService();
    if (current === undefined) {
      if (!entry.warned) {
        entry.warned = true;
        warn('userQuestions is unavailable; the parked question stays pending');
      }
      return;
    }
    entry.forwarding = true;
    let result;
    try {
      // The spread preserves the enumerable FORWARD symbol and the original
      // agent, questions and signal. The host's answerer now sees the attached
      // agent and claims the request; our own listener sees FORWARD and yields.
      result = current.ask({ ...entry.request, [FORWARD]: true });
    } catch (error) {
      entry.forwarding = false;
      handleForwardFailure(entry, error);
      return;
    }
    Promise.resolve(result).then(
      answer => {
        entry.forwarding = false;
        settle(entry, undefined, answer);
      },
      error => {
        entry.forwarding = false;
        handleForwardFailure(entry, error);
      },
    );
  }

  /**
   * @param {any} entry
   * @param {unknown} error
   */
  function handleForwardFailure(entry, error) {
    if (entry.settled) return;
    if (isInterruption(error)) {
      settle(entry, error);
      return;
    }
    if (isNoProvider(error)) {
      // The channel has not adopted the session yet, or the question panel is
      // still starting. Stay parked; a later inbox click can try again.
      return;
    }
    if (!entry.warned) {
      entry.warned = true;
      warn('forwarding a parked question failed', error);
    }
  }

  /**
   * Re-deliver the parked questions for one agent. Only the inbox jump scene
   * calls this, after the channel has adopted the session: that is the explicit
   * "open this conversation" action. The relay never forwards on its own.
   *
   * @param {string} agentId
   * @returns {boolean} whether at least one parked question was attempted
   */
  function deliver(agentId) {
    if (disposed) return false;
    const id = typeof agentId === 'string' ? agentId : '';
    if (id === '') return false;
    const list = parked.get(id);
    if (list === undefined) return false;
    let attempted = false;
    for (const entry of [...list]) {
      if (entry.settled || entry.forwarding) continue;
      forward(entry);
      attempted = true;
    }
    return attempted;
  }

  /**
   * The waterfall listener. It is deliberately written as a plain function so a
   * test can invoke it with a fake `next`.
   *
   * @param {any} request
   * @param {any} next
   * @returns {any}
   */
  function onRequest(request, next) {
    if (typeof next !== 'function') return undefined;
    const agentId = agentIdOf(request);
    if (agentId === '' || request?.[FORWARD] === true) return next();
    let result;
    try {
      result = next();
    } catch (error) {
      if (!isNoProvider(error) || isAttached(agentId)) throw error;
      return park(request);
    }
    if (!result || typeof result.then !== 'function') return result;
    return Promise.resolve(result).catch(error => {
      if (!isNoProvider(error)) throw error;
      if (isAttached(agentId)) throw error;
      return park(request);
    });
  }

  function attach() {
    if (disposed) return;
    if (typeof ctx?.on === 'function') {
      try {
        const off = ctx.on('user-questions/request', onRequest);
        if (typeof off === 'function') disposers.push(off);
      } catch (error) {
        warn('registering the question listener failed', error);
      }
    }
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['userQuestions'], ready => {
          try {
            const next = ready?.get?.('userQuestions', false);
            if (next && typeof next.ask === 'function') service = next;
          } catch {
            // `ctx.get` still resolves the service on demand.
          }
        });
      } catch {
        // Injection is an optimization, not a requirement.
      }
    }
    resolveService();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const entries = [];
    for (const list of parked.values()) entries.push(...list);
    for (const entry of entries) {
      settle(entry, questionError(
        'the background question relay was disposed before the user answered',
        'ASK_ABORTED',
      ));
    }
    parked.clear();
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
    deliver,
    dispose,
  };
}

/** Exported for tests only; the marker is otherwise module-private. */
export { FORWARD as QUESTION_FORWARD };
