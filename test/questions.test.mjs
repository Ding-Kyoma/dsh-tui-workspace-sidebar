import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION_FORWARD, createQuestionRelay } from '../questions.js';

function noProvider() {
  const error = new Error('no user-questions answerer accepted the request');
  error.name = 'UserQuestionError';
  error.code = 'NO_PROVIDER';
  return error;
}

function makeRequest(agentId = 'a', extra = {}) {
  return {
    agent: { id: agentId },
    questions: [{ id: 'q1', question: 'Continue?', options: [] }],
    source: 'test',
    ...extra,
  };
}

function makeService(handler = () => Promise.resolve({ answers: [] })) {
  const calls = [];
  let current = handler;
  return {
    calls,
    ask(request) {
      calls.push(request);
      return current(request);
    },
    setHandler(next) {
      current = next;
    },
  };
}

function makeHarness({ probe, current = '', service } = {}) {
  const listeners = new Map();
  const subscribers = new Set();
  const waiting = new Map();
  let currentId = current;

  const tracker = {
    getCurrentId() {
      return currentId;
    },
    setWaiting(id, value) {
      waiting.set(id, value);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };

  const ctx = {
    get(name, fallback) {
      return name === 'userQuestions' ? service : fallback;
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    inject(_deps, callback) {
      callback({
        get(name, fallback) {
          return name === 'userQuestions' ? service : fallback;
        },
      });
    },
  };

  const relay = createQuestionRelay({
    ctx,
    tracker,
    probe: probe ?? (() => currentId),
  });
  relay.attach();

  return {
    relay,
    waiting,
    tracker,
    listener() {
      const fn = listeners.get('user-questions/request')?.[0];
      assert.equal(typeof fn, 'function', 'the relay registered a waterfall listener');
      return fn;
    },
    listenerCount() {
      return listeners.get('user-questions/request')?.length ?? 0;
    },
    setCurrent(id) {
      currentId = id;
      for (const fn of [...subscribers]) fn();
    },
  };
}

test('relay: a request another answerer claims is passed through untouched', async () => {
  const harness = makeHarness();
  const answer = { answers: [{ id: 'q1', selected: ['yes'] }] };
  const result = harness.listener()(makeRequest(), () => Promise.resolve(answer));
  assert.deepEqual(await result, answer);
  assert.equal(harness.waiting.get('a'), undefined);
});

test('relay: NO_PROVIDER for a background agent parks the ask and marks the row', async () => {
  const service = makeService();
  const harness = makeHarness({ service });
  const request = makeRequest();
  const pending = harness.listener()(request, () => Promise.reject(noProvider()));
  await Promise.resolve();

  assert.equal(harness.waiting.get('a'), true);
  assert.equal(service.calls.length, 0);

  const answer = { answers: [{ id: 'q1', selected: ['yes'] }] };
  service.setHandler(req => {
    assert.equal(req[QUESTION_FORWARD], true, 'the relay marks its re-dispatch');
    assert.equal(req.agent.id, 'a');
    return Promise.resolve(answer);
  });
  assert.equal(harness.relay.deliver('a'), true);

  assert.deepEqual(await pending, answer);
  assert.equal(harness.waiting.get('a'), false);
  assert.equal(service.calls.length, 1);
});

test('relay: changing the attached session alone does not deliver a question', async () => {
  const service = makeService();
  const harness = makeHarness({ service });
  service.setHandler(() => Promise.resolve({ answers: [] }));
  const pending = harness.listener()(makeRequest(), () => Promise.reject(noProvider()));
  // Let the relay park first: a real jump is a later event, never the same
  // tick as the ask.
  await Promise.resolve();

  harness.setCurrent('a');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(service.calls.length, 0, 'the relay must not forward on attachment alone');
  assert.equal(harness.waiting.get('a'), true);

  assert.equal(harness.relay.deliver('a'), true);
  await pending;
  assert.equal(service.calls.length, 1);
  assert.equal(harness.waiting.get('a'), false);
});

test('relay: deliver ignores unknown and empty agents', () => {
  const service = makeService();
  const harness = makeHarness({ service });
  assert.equal(harness.relay.deliver(''), false);
  assert.equal(harness.relay.deliver('missing'), false);
  assert.equal(service.calls.length, 0);
});

test('relay: a forwarded NO_PROVIDER stays parked and a later click retries', async () => {
  const service = makeService(() => Promise.reject(noProvider()));
  const harness = makeHarness({ service });
  const pending = harness.listener()(makeRequest(), () => Promise.reject(noProvider()));
  await Promise.resolve();

  assert.equal(harness.relay.deliver('a'), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(service.calls.length, 1);
  assert.equal(harness.waiting.get('a'), true);

  const answer = { answers: [{ id: 'q1', selected: ['yes'] }] };
  service.setHandler(() => Promise.resolve(answer));
  assert.equal(harness.relay.deliver('a'), true);
  assert.deepEqual(await pending, answer);
  assert.equal(service.calls.length, 2);
});

test('relay: a cancelled forward settles the original ask with ASK_CANCELLED', async () => {
  const cancellation = Object.assign(new Error('cancelled'), {
    name: 'UserQuestionError',
    code: 'ASK_CANCELLED',
  });
  const service = makeService(() => Promise.reject(cancellation));
  const harness = makeHarness({ service });
  const pending = harness.listener()(makeRequest(), () => Promise.reject(noProvider()));
  await Promise.resolve();

  assert.equal(harness.relay.deliver('a'), true);
  await assert.rejects(pending, error => error === cancellation);
  assert.equal(harness.waiting.get('a'), false);
});

test('relay: an aborted turn rejects the parked ask with ASK_ABORTED', async () => {
  const controller = new AbortController();
  const harness = makeHarness();
  const request = makeRequest('a', { signal: controller.signal });
  const pending = harness.listener()(request, () => Promise.reject(noProvider()));
  await Promise.resolve();

  controller.abort();
  await assert.rejects(
    pending,
    error => error.name === 'UserQuestionError' && error.code === 'ASK_ABORTED',
  );
  assert.equal(harness.waiting.get('a'), false);
});

test('relay: dispose rejects parked asks, clears the row, and unregisters', async () => {
  const harness = makeHarness();
  const pending = harness.listener()(makeRequest(), () => Promise.reject(noProvider()));
  await Promise.resolve();
  assert.equal(harness.listenerCount(), 1);

  harness.relay.dispose();
  await assert.rejects(
    pending,
    error => error.name === 'UserQuestionError' && error.code === 'ASK_ABORTED',
  );
  assert.equal(harness.waiting.get('a'), false);
  assert.equal(harness.listenerCount(), 0);
});

test('relay: a non-NO_PROVIDER rejection is rethrown unchanged', async () => {
  const boom = new Error('boom');
  const harness = makeHarness();
  await assert.rejects(
    harness.listener()(makeRequest(), () => Promise.reject(boom)),
    error => error === boom,
  );
  assert.equal(harness.waiting.size, 0);
});

test('relay: an agentless request is delegated, never parked', async () => {
  const harness = makeHarness();
  let calls = 0;
  const result = await harness.listener()({ questions: [] }, () => {
    calls += 1;
    return Promise.resolve('handled');
  });
  assert.equal(calls, 1);
  assert.equal(result, 'handled');
  assert.equal(harness.waiting.size, 0);
});

test('relay: its own forwarded request is delegated, never parked twice', async () => {
  const harness = makeHarness();
  let calls = 0;
  const request = makeRequest('a', { [QUESTION_FORWARD]: true });
  const result = await harness.listener()(request, () => {
    calls += 1;
    return Promise.resolve('forwarded');
  });
  assert.equal(calls, 1);
  assert.equal(result, 'forwarded');
  assert.equal(harness.waiting.size, 0);
});

test('relay: a foreground NO_PROVIDER is rethrown, not hidden behind a parked row', async () => {
  const harness = makeHarness({ current: 'a' });
  await assert.rejects(
    harness.listener()(makeRequest('a'), () => Promise.reject(noProvider())),
    error => error.code === 'NO_PROVIDER',
  );
  assert.equal(harness.waiting.size, 0);
});

test('relay: several asks for one agent stay waiting until the last settles', async () => {
  const service = makeService();
  const harness = makeHarness({ service });
  const answers = [{ answers: [{ id: 'first' }] }, { answers: [{ id: 'second' }] }];
  const resolvers = [];
  service.setHandler(() => new Promise(resolve => resolvers.push(resolve)));
  const listener = harness.listener();
  const first = listener(makeRequest(), () => Promise.reject(noProvider()));
  const second = listener(makeRequest(), () => Promise.reject(noProvider()));
  await Promise.resolve();
  assert.equal(harness.waiting.get('a'), true);

  assert.equal(harness.relay.deliver('a'), true);
  await Promise.resolve();
  assert.equal(service.calls.length, 2, 'both parked asks were re-delivered');

  resolvers[0](answers[0]);
  assert.deepEqual(await first, answers[0]);
  assert.equal(harness.waiting.get('a'), true, 'the second ask is still parked');

  resolvers[1](answers[1]);
  assert.deepEqual(await second, answers[1]);
  assert.equal(harness.waiting.get('a'), false);
});

test('relay: a double click while a forward is in flight is a no-op', async () => {
  const service = makeService();
  const harness = makeHarness({ service });
  const pending = harness.listener()(makeRequest(), () => Promise.reject(noProvider()));
  await Promise.resolve();

  let resolve;
  service.setHandler(() => new Promise(done => {
    resolve = done;
  }));
  assert.equal(harness.relay.deliver('a'), true);
  assert.equal(harness.relay.deliver('a'), false);
  assert.equal(service.calls.length, 1);

  resolve({ answers: [] });
  await pending;
  assert.equal(harness.waiting.get('a'), false);
});
