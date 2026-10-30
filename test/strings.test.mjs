import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor } from '../strings.js';

test('header: the running counter uses the animation frame it is given', () => {
  const zh = messagesFor('zh');
  assert.equal(zh.header(2, 3, 5, '⠙'), '⠙ 2 运行 · ● 3 未读');
  assert.equal(zh.header(0, 1, 1, '⠙'), '● 1 未读');
  assert.equal(zh.header(0, 0, 4, '⠙'), '共 4 个会话');
  assert.equal(zh.header(0, 0, 0, '⠙'), '暂无会话');
});

test('header: a missing frame falls back to the first spinner glyph', () => {
  const zh = messagesFor('zh');
  assert.equal(zh.header(1, 0, 1), '⠋ 1 运行');
  assert.equal(zh.header(1, 2, 3, undefined), '⠋ 1 运行 · ● 2 未读');
});

test('header: English copy keeps the same animated frame contract', () => {
  const en = messagesFor('en');
  assert.equal(en.header(1, 2, 3, '⠏'), '⠏ 1 running · ● 2 unread');
  assert.equal(en.header(0, 0, 1, '⠏'), '1 conversation');
  assert.equal(en.header(0, 0, 0, '⠏'), 'nothing here yet');
});
