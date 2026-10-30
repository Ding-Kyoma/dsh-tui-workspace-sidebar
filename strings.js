/**
 * Localized copy for the workspace sidebar.
 *
 * The panel is rendered by the host, but the host does not hand plugins a
 * translator. Language follows the same preference order dsh-tui itself uses:
 * explicit plugin config, the live panel snapshot, `DSH_TUI_LANG`,
 * `~/.dsh-tui/lang.json`, then the process locale.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZH = {
  lang: 'zh',
  title: '收件箱',
  commandDescription: '打开收件箱侧栏（正在运行 / 近期会话）',
  shortcutDescription: '打开收件箱侧栏',
  sceneTitle: '收件箱操作',
  untitled: '未命名会话',
  unknownProject: '未知项目',
  emptyTitle: '收件箱是空的',
  emptyHint(hours) {
    const value = Number(hours);
    if (!(value > 0)) return '读过的会话会立即移除';
    return `最近 ${value} 小时活跃过的会话会显示在这里`;
  },
  liveUnavailable: '当前内核不提供实时会话状态，只显示磁盘上的记录',
  hintFocused: '↑↓ 选择 · Enter 跳转 · n 新建 · m 已读 · r 刷新',
  hintIdle: 'Ctrl+B 聚焦 · 点击行跳转 · + 新建',
  header(running, unread, total, spinner = '⠋') {
    const parts = [];
    if (running > 0) parts.push(`${spinner} ${running} 运行`);
    if (unread > 0) parts.push(`● ${unread} 未读`);
    if (parts.length > 0) return parts.join(' · ');
    return total > 0 ? `共 ${total} 个会话` : '暂无会话';
  },
  opening: '正在打开会话…',
  newOpening: '正在新建会话…',
  newUnavailable: '无法新建：场景服务不可用',
  newUnsupported: '当前内核不支持新建会话',
  newBackgroundFailed: '当前任务无法转入后台，请等它结束',
  newError: '新建会话失败：{{err}}',
  alreadyHere: '已经在这个会话里了',
  jumpUnavailable: '无法跳转：场景服务不可用',
  openWorking: '当前有任务在跑，暂时不能切换',
  openUnavailable: '该会话当前不可用',
  openCancelled: '已取消',
  openError: '打开失败：{{err}}',
  openOccupied: '被其他 TUI 终端占用（pid {{pid}}）',
  openUnknown: '未知原因',
  markedRead: '已标记为已读',
  cannotMarkRunning: '运行中的会话不能标记已读',
  panelUnavailable: '收件箱侧栏不可用',
};

const EN = {
  lang: 'en',
  title: 'Inbox',
  commandDescription: 'Open the inbox panel (running / recent conversations)',
  shortcutDescription: 'Open the inbox panel',
  sceneTitle: 'Inbox action',
  untitled: 'Untitled session',
  unknownProject: 'Unknown project',
  emptyTitle: 'The inbox is empty',
  emptyHint(hours) {
    const value = Number(hours);
    if (!(value > 0)) return 'Read conversations are removed immediately';
    return `Conversations active in the last ${value}h show up here`;
  },
  liveUnavailable: 'This kernel exposes no live session status; showing persisted records only',
  hintFocused: '↑↓ select · Enter jump · n new · m read · r refresh',
  hintIdle: 'Ctrl+B to focus · click a row to jump · + new',
  header(running, unread, total, spinner = '⠋') {
    const parts = [];
    if (running > 0) parts.push(`${spinner} ${running} running`);
    if (unread > 0) parts.push(`● ${unread} unread`);
    if (parts.length > 0) return parts.join(' · ');
    return total > 0 ? `${total} conversation${total === 1 ? '' : 's'}` : 'nothing here yet';
  },
  opening: 'Opening session…',
  newOpening: 'Creating a new session…',
  newUnavailable: 'Cannot create: the scene service is unavailable',
  newUnsupported: 'This kernel cannot create a session',
  newBackgroundFailed: 'This turn cannot be backgrounded yet; wait for it to finish',
  newError: 'New session failed: {{err}}',
  alreadyHere: 'You are already in this session',
  jumpUnavailable: 'Cannot jump: the scene service is unavailable',
  openWorking: 'A turn is in progress; try again shortly',
  openUnavailable: 'That session is currently unavailable',
  openCancelled: 'Cancelled',
  openError: 'Open failed: {{err}}',
  openOccupied: 'Held by another TUI terminal (pid {{pid}})',
  openUnknown: 'Unknown reason',
  markedRead: 'Marked as read',
  cannotMarkRunning: 'A running session cannot be marked read',
  panelUnavailable: 'The inbox panel is unavailable',
};

/**
 * Fill `{{name}}` placeholders. Unknown keys become an empty string, so a
 * translation typo never renders braces in the terminal.
 * @param {string} template
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function fmt(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * @param {unknown} value
 * @returns {'zh' | 'en' | undefined}
 */
export function parseLang(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'zh' || text === 'en' ? text : undefined;
}

/**
 * Resolve the UI language for this plugin.
 * @param {unknown} preferred plugin config value
 * @param {unknown} hostLang live snapshot value
 * @returns {'zh' | 'en'}
 */
export function resolveLang(preferred, hostLang) {
  const explicit = parseLang(preferred);
  if (explicit !== undefined) return explicit;

  const host = parseLang(hostLang);
  if (host !== undefined) return host;

  const env = parseLang(process.env.DSH_TUI_LANG);
  if (env !== undefined) return env;

  try {
    const raw = readFileSync(join(homedir(), '.dsh-tui', 'lang.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const saved = parseLang(parsed?.lang);
    if (saved !== undefined) return saved;
  } catch {
    // No persisted choice: fall through to the locale.
  }

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    if (locale.toLowerCase().startsWith('zh')) return 'zh';
  } catch {
    // Intl is always present on supported Node versions; be tolerant anyway.
  }
  return 'en';
}

/**
 * @param {'zh' | 'en'} lang
 * @returns {typeof ZH}
 */
export function messagesFor(lang) {
  return lang === 'zh' ? ZH : EN;
}
