import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULT_RETENTION_HOURS, DEFAULT_SHORTCUT } from '../index.js';
import { DEFAULT_STATE_FILE } from '../store.js';

test('Config supplies the documented defaults', () => {
  const result = Config['~standard'].validate({});
  assert.equal(result.issues, undefined);
  assert.deepEqual(result.value, {
    lang: 'auto',
    stateFile: DEFAULT_STATE_FILE,
    shortcut: DEFAULT_SHORTCUT,
    retentionHours: DEFAULT_RETENTION_HOURS,
    relayQuestions: true,
  });
});

test('Config accepts every documented knob', () => {
  const result = Config['~standard'].validate({
    lang: 'zh',
    stateFile: '~/workspace-sidebar.json',
    shortcut: 'off',
    retentionHours: 0,
    relayQuestions: false,
  });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.lang, 'zh');
  assert.equal(result.value.stateFile, '~/workspace-sidebar.json');
  assert.equal(result.value.shortcut, 'off');
  assert.equal(result.value.retentionHours, 0);
  assert.equal(result.value.relayQuestions, false);
});

test('Config rejects a wrong type instead of silently accepting it', () => {
  // Range handling stays in normalizeConfig (a number outside the window is
  // clamped); the host schema is only responsible for the declared types.
  const result = Config['~standard'].validate({ retentionHours: 'many' });
  assert.ok(Array.isArray(result.issues));
  assert.ok(result.issues.length > 0);
});
