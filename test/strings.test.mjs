import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor } from '../strings.js';

test('header: the running counter is static and keeps a blank icon cell', () => {
  const zh = messagesFor('zh');
  assert.equal(zh.header(2, 3, 5), ' 2 运行 · ● 3 未读');
  assert.equal(zh.header(1, 0, 1), ' 1 运行');
  assert.equal(zh.header(0, 1, 1), '● 1 未读');
  assert.equal(zh.header(0, 0, 4), '共 4 个会话');
  assert.equal(zh.header(0, 0, 0), '暂无会话');
  assert.doesNotMatch(zh.header(1, 0, 1), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test('header: English copy matches the static contract', () => {
  const en = messagesFor('en');
  assert.equal(en.header(1, 2, 3), ' 1 running · ● 2 unread');
  assert.equal(en.header(0, 0, 1), '1 conversation');
  assert.equal(en.header(0, 0, 0), 'nothing here yet');
  assert.doesNotMatch(en.header(1, 0, 1), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test('new-session copy exists in both languages and is advertised in the footer', () => {
  for (const lang of ['zh', 'en']) {
    const copy = messagesFor(lang);
    for (const key of ['newOpening', 'newUnavailable', 'newUnsupported', 'newBackgroundFailed', 'newError']) {
      assert.equal(typeof copy[key], 'string', `${lang}.${key}`);
      assert.ok(copy[key].length > 0, `${lang}.${key} is not empty`);
    }
    assert.match(copy.newError, /\{\{err\}\}/);
    assert.match(copy.hintFocused, /n /, `${lang}.hintFocused mentions the key`);
    assert.match(copy.hintIdle, /\+/, `${lang}.hintIdle mentions the + affordance`);
  }
});

test('the idle footer leaves the focus key to the host', () => {
  // dsh-tui draws its own `panel-hint-unfocused` line ("Ctrl+B 聚焦侧栏") in
  // the rule below an unfocused panel. The plugin footer sits directly above
  // that rule, so advertising Ctrl+B there renders the same key twice.
  for (const lang of ['zh', 'en']) {
    const copy = messagesFor(lang);
    assert.doesNotMatch(copy.hintIdle, /Ctrl\+B/i, `${lang}.hintIdle must not repeat the host focus hint`);
    assert.doesNotMatch(copy.hintFocused, /Ctrl\+B/i, `${lang}.hintFocused must not repeat the host focus hint`);
  }
});

test('waiting copy exists in both languages', () => {
  assert.equal(messagesFor('zh').waiting, '待回答');
  assert.equal(messagesFor('en').waiting, 'needs you');
});
