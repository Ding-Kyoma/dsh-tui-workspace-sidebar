import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmt, messagesFor, parseLang, resolveLang } from '../strings.js';

/** Every `{{name}}` token in a template, sorted for a stable comparison. */
function placeholders(template) {
  return [...String(template).matchAll(/\{\{(\w+)\}\}/g)]
    .map(match => match[1])
    .sort();
}

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

test('the empty hint states the window in days once it spans a day', () => {
  const zh = messagesFor('zh');
  const en = messagesFor('en');
  assert.equal(zh.emptyHint(168), '最近 7 天活跃过的会话会显示在这里');
  assert.equal(en.emptyHint(168), 'Conversations active in the last 7 days show up here');
  assert.equal(zh.emptyHint(36), '最近 1.5 天活跃过的会话会显示在这里');
  assert.equal(en.emptyHint(36), 'Conversations active in the last 1.5 days show up here');
  assert.equal(zh.emptyHint(6), '最近 6 小时活跃过的会话会显示在这里');
  assert.equal(en.emptyHint(6), 'Conversations active in the last 6h show up here');
  assert.equal(zh.emptyHint(0), '读过的会话会立即移除');
  assert.equal(en.emptyHint(0), 'Read conversations are removed immediately');
});

test('waiting copy exists in both languages', () => {
  assert.equal(messagesFor('zh').waiting, '待回答');
  assert.equal(messagesFor('en').waiting, 'needs you');
});

test('both languages define the same keys with the same value types', () => {
  const zh = messagesFor('zh');
  const en = messagesFor('en');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], typeof en[key], `${key} type`);
  }
});

test('translated templates keep the same placeholders', () => {
  const zh = messagesFor('zh');
  const en = messagesFor('en');
  for (const key of Object.keys(zh)) {
    if (typeof zh[key] !== 'string') continue;
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
  }
  for (const key of ['newError', 'openError', 'openOccupied']) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
  }
});

test('fmt fills known placeholders and blanks unknown ones', () => {
  assert.equal(fmt('New session failed: {{err}}', { err: 'boom' }), 'New session failed: boom');
  assert.equal(fmt('{{a}}/{{b}}', { a: 1, b: 2 }), '1/2');
  assert.equal(fmt('{{missing}}'), '');
});

test('parseLang accepts only the shipped language ids', () => {
  assert.equal(parseLang('zh'), 'zh');
  assert.equal(parseLang(' EN '), 'en');
  assert.equal(parseLang('auto'), undefined);
  assert.equal(parseLang('fr'), undefined);
  assert.equal(parseLang(undefined), undefined);
});

test('messagesFor falls back to English for an unknown language', () => {
  assert.equal(messagesFor('zh').title, '收件箱');
  assert.equal(messagesFor('en').title, 'Inbox');
  assert.equal(messagesFor('fr').title, 'Inbox');
});

test('resolveLang: an explicit plugin language wins over the live host', () => {
  assert.equal(resolveLang('zh', 'en'), 'zh');
  assert.equal(resolveLang('en', 'zh'), 'en');
  assert.equal(resolveLang('auto', 'zh'), 'zh');
  assert.equal(resolveLang('fr', 'en'), 'en');
});

test('resolveLang: the live host wins over DSH_TUI_LANG', () => {
  const previous = process.env.DSH_TUI_LANG;
  try {
    process.env.DSH_TUI_LANG = 'zh';
    assert.equal(resolveLang('auto', 'en'), 'en');
    assert.equal(resolveLang('auto', undefined), 'zh');
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_LANG;
    else process.env.DSH_TUI_LANG = previous;
  }
});

test('resolveLang: the saved choice is used when the host and env are silent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-sidebar-lang-'));
  const previousHome = process.env.HOME;
  const previousLang = process.env.DSH_TUI_LANG;
  try {
    delete process.env.DSH_TUI_LANG;
    process.env.HOME = home;
    await mkdir(join(home, '.dsh-tui'), { recursive: true });
    await writeFile(join(home, '.dsh-tui', 'lang.json'), JSON.stringify({ lang: 'zh' }), 'utf8');
    assert.equal(resolveLang('auto', undefined), 'zh');
    await writeFile(join(home, '.dsh-tui', 'lang.json'), JSON.stringify({ lang: 'en' }), 'utf8');
    assert.equal(resolveLang('auto', undefined), 'en');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousLang === undefined) delete process.env.DSH_TUI_LANG;
    else process.env.DSH_TUI_LANG = previousLang;
    await rm(home, { recursive: true, force: true });
  }
});
