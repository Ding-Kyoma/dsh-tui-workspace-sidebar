import test from 'node:test';
import assert from 'node:assert/strict';
import { createJumpQueue, performJump } from '../jump.js';

test('jump queue: one slot, consumed once, expires', () => {
  let now = 1_000;
  const queue = createJumpQueue({ now: () => now, ttl: 100 });
  queue.request({ id: 'a', title: 'A', cwd: '/r', lang: 'zh' });
  queue.request({ id: 'b', title: 'B' });
  const target = queue.take();
  assert.equal(target.id, 'b');
  assert.equal(target.lang, undefined);
  assert.equal(queue.take(), undefined);

  queue.request({ id: 'c' });
  now += 101;
  assert.equal(queue.take(), undefined);
});

test('jump queue ignores empty targets and clear() drops the slot', () => {
  const queue = createJumpQueue();
  queue.request({ id: '' });
  assert.equal(queue.peek(), undefined);
  queue.request({ id: 'a' });
  queue.clear();
  assert.equal(queue.peek(), undefined);
});

test('performJump: success marks the row and closes', async () => {
  const calls = [];
  const result = await performJump({
    channel: { resumeTo: async id => { calls.push(id); return { ok: true }; } },
    target: { id: 's1', lang: 'en' },
    onSeen: id => calls.push(`seen:${id}`),
    notify: text => calls.push(`notify:${text}`),
    close: () => calls.push('close'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['s1', 'seen:s1', 'close']);
});

test('performJump: failures notify, never mark seen, and close the scene', async () => {
  const cases = [
    { reason: 'occupied', pid: 99, expect: 'pid 99' },
    { reason: 'working', expect: 'in progress' },
    { reason: 'cancelled', expect: 'Cancelled' },
    { reason: 'failed', error: 'boom', expect: 'boom' },
  ];
  for (const spec of cases) {
    const calls = [];
    const result = await performJump({
      channel: { resumeTo: async () => ({ ok: false, ...spec }) },
      target: { id: 's1', lang: 'en' },
      onSeen: () => calls.push('seen'),
      notify: text => calls.push(text),
      close: () => calls.push('close'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, spec.reason);
    assert.ok(calls.some(text => text.includes(spec.expect)), `${spec.reason} should toast ${spec.expect}`);
    assert.ok(!calls.includes('seen'));
    assert.equal(calls.at(-1), 'close');
  }
});

test('performJump: unavailable is already toasted by the adapter, so it stays quiet', async () => {
  const calls = [];
  await performJump({
    channel: { resumeTo: async () => ({ ok: false, reason: 'unavailable' }) },
    target: { id: 's1', lang: 'en' },
    notify: text => calls.push(text),
    close: () => calls.push('close'),
  });
  assert.deepEqual(calls, ['close']);
});

test('performJump: a throwing resume and a missing channel both close', async () => {
  const thrown = [];
  const result = await performJump({
    channel: { resumeTo: async () => { throw new Error('nope'); } },
    target: { id: 's1', lang: 'en' },
    notify: text => thrown.push(text),
    close: () => thrown.push('close'),
  });
  assert.equal(result.ok, false);
  assert.ok(thrown.some(text => text.includes('nope')));

  const missing = [];
  const noChannel = await performJump({
    channel: undefined,
    target: { id: 's1', lang: 'en' },
    notify: text => missing.push(text),
    close: () => missing.push('close'),
  });
  assert.equal(noChannel.ok, false);
  assert.ok(missing.length >= 2);
  assert.equal(missing.at(-1), 'close');
});
