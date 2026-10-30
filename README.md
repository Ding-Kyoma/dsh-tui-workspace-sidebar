# dsh-tui-workspace-sidebar

A light right-side panel for dsh-tui that answers one question at a glance:
**what is running, what finished while I was not looking, and where am I?**

It uses a normal side-panel tab instead of a full-screen view: grouped by
project, one line per conversation, hover to highlight, click to jump.

```
⠋ 1 运行 · ● 1 未读
▾ dsh-plugins
❯ ✓ 修复登录页样式            刚刚
  ⠋ 给补丁跑个验证            2 分钟前
  ● 重写 README               5 分钟前
▾ other-project
  ✓ 更新部署脚本              3 小时前
↑↓ 选择 · Enter 跳转 · m 已读 · r 刷新
```

## What it shows

Three kinds of conversations, across every workspace that is live in this TUI
process:

- **Running** — the session's agent is inside a turn. The braille spinner is
  the chat's own spinner, frame for frame (80 ms). The header's running count
  and each project's counter drive the same frames, so all three spin in
  lockstep.
- **Finished but unread** — a turn ended while you were in another session. The
  row shows a solid dot `●` (`✕` when the turn failed) and is bold for the
  first few seconds.
- **Finished and already read** — jumping to a conversation (or pressing `m`)
  no longer removes it; the dot becomes a dim `✓` and the row stays for the
  rest of the retention window, so the place you just came from is still there.

A finished conversation — read or unread — is swept once it has been idle for
**6 hours** (`retentionHours`, configurable). The attached conversation is
always listed and is the default selection: a `❯` cursor marks it while the
panel has focus, and a tinted title keeps it findable otherwise. Its row is
never filled; only the row under the mouse gets the highlight background. It is
pinned regardless of age while you are in it.

Inside a project, rows are ordered by when their **current state began**, not by
their latest event: a running row is anchored to the start of its current turn,
a finished row to the moment it finished. Activity inside a turn — tokens, tool
calls, step markers, background job events — never reorders the list, so two
conversations running at the same time keep a fixed relative order instead of
trading places on every event. A new turn lifts its row once, and an exact tie
is broken running-first, then by session id. The relative time on the right
still reports the last activity (it is also what the retention window uses).

Everything else is hidden: idle sessions that never ran, subagents, and
projects with nothing to triage. The attached session is never counted as
unread (no badge for the conversation already on screen).

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
    retentionHours: 6                           # 0 = drop a row as soon as it is read
```

`retentionHours` accepts fractions (useful to watch the sweep happen) and is
capped at 720 (30 days). The row cap of 300 stays as a hard bound.

## Interaction

| Input | Action |
| --- | --- |
| hover a row | fill it (transient; selecting a row does not fill it) |
| click a row | jump to that workspace + session |
| `↑` / `↓` | move the selection (while the panel is focused) |
| `Enter` | jump to the selected conversation |
| `m` | mark the selected finished row as read (the row stays, dimmed) |
| `r` | refresh the agent roster and workspace titles |
| wheel | scroll the list |

## How the jump works

A plugin panel gets no `channel`, so it cannot call `channel.resumeTo` itself.
The only public seam that hands a plugin a live channel is a registered scene.
The panel therefore leaves a one-shot target in a queue and opens a small
transition scene; that scene performs the resume and closes.

The panel and the scene are registered from **one** injected context on
purpose. dsh-tui attributes resource ownership to the calling activation
context, and `host.openScene()` checks the scene's owner against the panel's
owner. Registering them from two sibling `ctx.inject` callbacks gives them two
different fibers, so the host refuses to open the scene ("belongs to another
activation") even though `sceneReady()` is true. One injection for both
(`['tuiPanels', 'tuiScenes']`) keeps the owners identical.

Expect a brief full-screen card (`▣ project / title / 正在打开会话…`) for the
duration of the resume. It is a trampoline, not a second inbox; there is no
workspace list there.

Failure reasons are mapped to toasts and the row stays unread: `occupied`
(another TUI terminal holds the session, with its pid), `working`,
`cancelled`, `failed`, `unavailable` (the adapter already toasts this one).
A successful jump marks the row read but keeps it in the list, so the
conversation you came from is still one click away until its window closes.

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
Finished rows survive restarts with their titles and read state — read ones
included, until their retention window closes. Rows past `retentionHours` (or
beyond the 300-row cap) are pruned, and a hidden panel still sweeps them on
time through one unref'd timer, so the tab badge shrinks without being opened.
A corrupt file is preserved as `workspace-sidebar.json.corrupt-<epoch>` before
an empty state is used.

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
  (for example the Claude/Codex adapters) gets recent rows from disk only; the
  panel says so instead of pretending to be live.
- **Pinned current row.** The attached conversation is never swept while it is
  attached, even after a long idle stretch. Switch away and it expires with the
  rest at the next sweep.
- **One lifecycle.** Do not install two copies under different names: the
  second activation cannot register the same panel/scene ids.

## Tests

```sh
npm test        # node --test: model, tracker, store, discovery, jump, apply, strings, panel
```

The tests cover the transition table (`running → finished → seen`), the
retention window (visibility, pruning, next-expiry), the current-session rule
(listed, pinned, never unread), the ordering anchor (running rows anchored to
their turn start, finished rows to their finish marker, so concurrent running
conversations never swap as their logs advance), subagent/no-prompt filtering,
grouping, store atomicity/corruption, the jump failure matrix, the animated
running counters and hover-only row fill, and the panel/scene/command/shortcut
registration (including feature-detected degradation).
