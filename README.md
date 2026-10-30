# dsh-tui-workspace-sidebar

A light right-side panel for dsh-tui that answers one question at a glance:
**which conversations are running, and which finished while I was not looking?**

It replaces the full-screen `dsh-tui-workspace-inbox` approach with a normal
side-panel tab: grouped by project, one line per conversation, hover to
highlight, click to jump.

```
⠋ 2 运行 · ✓ 1 未读
▾ dsh-plugins
❯⠋ 修复登录页样式            刚刚
 ✓ 给补丁跑个验证            3 分钟前
▾ other-project
 ✓ 重写 README               1 小时前
↑↓ 选择 · Enter 跳转 · m 已读 · r 刷新
```

## What it shows

Only two kinds of conversations, across every workspace that is live in this
TUI process:

- **Running** — the session's agent is inside a turn. The braille spinner is
  the chat's own spinner, frame for frame (80 ms).
- **Finished but unread** — a turn ended while you were in another session.
  The row shows `✓` (`✕` when the turn failed) and is bold for the first few
  seconds.

Everything else is hidden: finished-and-read conversations, idle sessions that
never ran, subagents, and projects with nothing to triage.

The current session is never listed (you are already looking at it) and never
counted as unread.

## Install

```sh
dsh plugin --profile dsh-tui add link:/absolute/path/to/dsh-tui-workspace-sidebar
```

Then restart the TUI (a newly added bundle is not picked up by a running
process). The tab appears as `▣ 收件箱` (or `▣ Inbox`); `Ctrl+B` opens the
sidebar, `[`/`]` cycle panels, and the panel is also listed by `/panel`.

The plugin also registers:

- `/ws` — open the sidebar panel.
- `alt+w` — same, configurable or disable with `shortcut: off`.

## Config

Patch the row by id in the profile's own `cordis.patch.yml` (a row patch
replaces the whole `config`, so restate every key you need):

```yaml
- id: workspace-sidebar
  config:
    lang: auto                                  # auto | zh | en
    stateFile: ~/.dsh-tui/workspace-sidebar.json
    shortcut: alt+w                             # off disables it
```

## Interaction

| Input | Action |
| --- | --- |
| hover a row | highlight it |
| click a row | jump to that workspace + session |
| `↑` / `↓` | move the selection (while the panel is focused) |
| `Enter` | jump to the selected conversation |
| `m` | mark the selected finished row as read |
| `r` | refresh the agent roster and workspace titles |
| wheel | scroll the list |

## How the jump works

A plugin panel gets no `channel`, so it cannot call `channel.resumeTo` itself.
The only public seam that hands a plugin a live channel is a registered scene.
The panel therefore leaves a one-shot target in a queue and opens a small
transition scene; that scene performs the resume and closes.

Expect a brief full-screen card (`▣ project / title / 正在打开会话…`) for the
duration of the resume. It is a trampoline, not a second inbox; there is no
workspace list there.

Failure reasons are mapped to toasts and the row stays unread: `occupied`
(another TUI terminal holds the session, with its pid), `working`,
`cancelled`, `failed`, `unavailable` (the adapter already toasts this one).

## Persistence

State lives in `~/.dsh-tui/workspace-sidebar.json` (mode `0600`, atomic
rename, debounced writes):

```json
{
  "version": 1,
  "sessions": {
    "<session id>": {
      "cwd": "/Users/you/project",
      "title": "Fix the login page",
      "status": "finished",
      "failed": false,
      "updatedAt": 1761000000000,
      "finishedAt": 1761000000000,
      "seenAt": 0
    }
  }
}
```

A row persisted as `running` is dropped on the next start: the previous
process died mid-turn, so there is nothing this process can report about it.
Finished-unread rows survive restarts with their titles, and rows older than
14 days (or beyond the 300-row cap) are pruned. A corrupt file is preserved as
`workspace-sidebar.json.corrupt-<epoch>` before an empty state is used.

## Limitations

- **Same process only.** The plugin folds the core agent registry
  (`ctx.agents`) and the live session event logs of this TUI process. dsh-tui
  0.17.0 exposes no cross-process roster, so conversations that only exist on
  disk are invisible until resumed.
- **Temporary panel id.** The plugin ships without a `dsh-plugin.json`
  manifest, so the host assigns a per-activation id
  (`session:actN:inbox`). That id cannot be persisted; it is re-resolved from
  `panels.list()` on every activation. Adding a verified manifest later would
  make the id stable and unlock plugin storage/decision events.
- **Transition card.** The full-screen flash is the only public-API path to a
  session switch in 0.17.0. If a direct `host.openSession`-style API appears,
  the panel will prefer it and keep the scene as a fallback.
- **Non-DSH kernels.** A kernel that does not provide the `agents` service
  (for example the Claude/Codex adapters) gets unread rows from disk only; the
  panel says so instead of pretending to be live.
- **One lifecycle.** Do not install two copies under different names: the
  second activation cannot register the same panel/scene ids.

## Relation to `dsh-tui-workspace-inbox`

Both plugins are independent and can coexist technically (`/inbox` vs `/ws`),
but they answer the same question with different weights. This one is the
lightweight sidebar; the inbox plugin is the full-screen triage screen with
search, filtering and a workspace rail. Only one is needed.

## Tests

```sh
npm test        # node --test: model, tracker, store, discovery, jump, apply
```

The tests cover the transition table (`running → finished → seen`), the
current-session rule, subagent/no-prompt filtering, grouping and pruning,
store atomicity/corruption, the jump failure matrix, and the panel/scene/
command/shortcut registration (including feature-detected degradation).
