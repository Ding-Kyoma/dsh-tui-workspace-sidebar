# dsh-tui-workspace-sidebar

A light right-side panel for dsh-tui that answers one question at a glance:
**what is running, what finished while I was not looking, and where am I?**

It uses a normal side-panel tab instead of a full-screen view: grouped by
project, one line per conversation, hover to highlight, click to jump. A `+`
after a project's counters starts a fresh conversation in that workspace.

```
 2 运行 · ● 2 未读
▸ dsh-plugins ⠋2 ●2 +
  ● 后台计划                  待回答
  ● 重写 README               5 分钟前
  ⠋ 给补丁跑个验证            2 分钟前
❯ ✓ 修复登录页样式            刚刚
▸ other-project +
  ✓ 更新部署脚本              3 小时前
↑↓ 选择 · Enter 跳转 · n 新建 · m 已读 · r 刷新
```

## What it shows

Four kinds of conversations, across every workspace that is live in this TUI
process:

- **Running** — the session's agent is inside a turn. Row glyphs and each
  project's counter use the chat's own braille spinner, frame for frame (80
  ms), so they spin in lockstep. The header's running count is plain text: it
  carries no spinner and stays still. A row whose agent is in **plan mode**
  (the durable `plan/mode` selection written by `dsh-plan-mode`) spins in the
  theme's plan colour — sage green on the default dark palette, the same role
  the status line uses — while project counters keep their muted spinner. Only
  a running row is coloured; a finished conversation never keeps it.
- **Finished but unread** — a turn ended while you were in another session. The
  row shows a solid dot `●` (`✕` when the turn failed) and is bold for the
  first few seconds.
- **Waiting for your answer** — a background session called
  `ask_user_question` or `exit_plan_mode`. It uses the same green `●` as an
  unread finish, stays bold until the question settles, and carries a dim
  `待回答` (`needs you`) suffix so the two are distinguishable. The running and
  unread counters both include it. Clicking the row jumps to the session and the
  host's normal questionnaire / plan-review panel appears; the original tool
  call is still waiting for that answer. See
  [Background questions](#background-questions).
- **Finished and already read** — jumping to a conversation (or pressing `m`)
  no longer removes it; the dot becomes a dim `✓` and the row stays for the
  rest of the retention window, so the place you just came from is still there.
  At most ten read rows are listed per project (see below).

A finished conversation — read or unread — is swept once it has been idle for
**6 hours** (`retentionHours`, configurable). The attached conversation is
always listed and is the default selection: a `❯` cursor marks it while the
panel has focus, and a tinted title keeps it findable otherwise. Its row is
never filled; only the row under the mouse gets the highlight background. It is
pinned regardless of age while you are in it.

Inside a project, rows are grouped by what wants attention first: **finished but
unread** conversations and **parked questions** lead, then **running** ones, then
everything already dealt with (read finishes, which includes the attached
conversation once its turn is over). Within a class rows are ordered by when their
**current state began**, not by their latest event: a running row is anchored to
the start of its current turn, a finished row to the moment it finished, and a
waiting row to the moment the question was parked. Activity inside a turn —
tokens, tool calls, step markers, background job events — never reorders the
list, so two conversations running at the same time keep a fixed relative order
instead of trading places on every event. A new turn lifts its row once, and an
exact tie falls back to the session id. Projects follow the same class priority,
so the first rows of the panel are always the ones that want attention. Inside a
class projects also keep a fixed order — the slot where the project first
appeared in this run, never an activity timestamp — so a new turn in one
workspace cannot make two running workspaces trade places; only a change of
class (a turn finishing unread, a question being parked, or an unread row being
read) moves a project. The relative time on the right still reports the last
activity (it is also what the retention window uses).

Each project lists at most **10 already-read** conversations. Running, waiting
and unread rows are never capped, and the attached conversation always keeps a
slot: when it is an older read row it displaces the tenth, so the panel never
loses the row you are on. The cap is display-only — the state file still retains
everything the retention window allows, so the next-oldest conversation appears
when one of the kept rows expires.

Everything else is hidden: idle sessions that never ran, subagents, and
projects with nothing to triage. The attached session is never counted as
unread (no badge for the conversation already on screen). A waiting row is also
never swept by the retention window — the question is still waiting for an
answer, so its green dot stays until the tool call settles.

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
    relayQuestions: true                        # false disables the background-question relay
```

`retentionHours` accepts fractions (useful to watch the sweep happen) and is
capped at 720 (30 days). The row cap of 300 stays as a hard bound.

`relayQuestions` is on by default. It is the fallback for background
`ask_user_question` / `exit_plan_mode` (see below); set it to `false` if the
host already handles those questions itself, or if you want the old immediate
`NO_PROVIDER` behavior back.

## Interaction

| Input | Action |
| --- | --- |
| hover a row | fill it (transient; selecting a row does not fill it) |
| click a row | jump to that workspace + session |
| click a project's `+` | start a fresh conversation in that workspace (see below) |
| `↑` / `↓` | move the selection (while the panel is focused) |
| `Enter` | jump to the selected conversation |
| `n` | start a fresh conversation in the selected row's workspace |
| `m` | mark the selected finished row as read (the row stays, dimmed) |
| `r` | refresh the agent roster and workspace titles |
| wheel | scroll the list |

## How a switch works

A plugin panel gets no `channel`, so it cannot call `channel.resumeTo` or
`channel.switchWorkspace` itself. The only public seam that hands a plugin a
live channel is a registered scene. The panel therefore leaves a one-shot
target in a queue and opens a small transition scene; that scene performs the
action and closes. A row click queues a resume; a project's `+` (or `n`) queues
a new-session request.

The panel and the scene are registered from **one** injected context on
purpose. dsh-tui attributes resource ownership to the calling activation
context, and `host.openScene()` checks the scene's owner against the panel's
owner. Registering them from two sibling `ctx.inject` callbacks gives them two
different fibers, so the host refuses to open the scene ("belongs to another
activation") even though `sceneReady()` is true. One injection for both
(`['tuiPanels', 'tuiScenes']`) keeps the owners identical.

Expect a brief full-screen card (`▣ project / title / 正在打开会话…`) for the
duration of a jump. It is a trampoline, not a second inbox; there is no
workspace list there.

Failure reasons are mapped to toasts and the row stays unread: `occupied`
(another TUI terminal holds the session, with its pid), `working`,
`cancelled`, `failed`, `unavailable` (the adapter already toasts this one).
A successful jump marks the row read but keeps it in the list, so the
conversation you came from is still one click away until its window closes.

### New session from a workspace header

`+` sits after the running/unread counters on every project header, to the
right of all the header icons. Its cell is padded on both sides, so the click
target is a little wider than the glyph; `n` does the same for the workspace of
the selected row. The `+` is omitted for the "unknown project" bucket, which
has no cwd to start a session in. Clicking it behaves like `/new` inside that
workspace.

| attached session | clicked workspace | what happens |
| --- | --- | --- |
| idle | the attached one | `/new` (`channel.newSession()`) |
| idle | another one | workspace handoff (`channel.switchWorkspace()`) |
| running a turn | the attached one | `/bg` first (`channel.backgroundCurrent()`); the fresh session it creates is already in that cwd |
| running a turn | another one | `/bg`, then the workspace handoff on the now-idle fresh session |

A running turn is never killed: it keeps going as a background session and
stays listed with its spinner. An idle session is replaced `/new`-style, and
its row stays in the list as a read finish. The fresh conversation itself joins
the list once it has a prompt (never-prompted idle sessions stay hidden, as
before). When the host refuses (a turn started in between, the directory
disappeared, the handoff failed) the channel's own notice explains why and the
card closes. A kernel that exposes neither `newSession` nor `switchWorkspace`
gets "当前内核不支持新建会话".

## Background questions

dsh-tui 0.17.0's answerer is bound to the session attached to the channel: it
claims `user-questions/request` only when `request.agent.id` is the current
channel agent, and calls `next()` for every other agent. A background session
that calls `ask_user_question` / `exit_plan_mode` therefore ends the ask at
`NO_PROVIDER` ("no user-questions answerer accepted the request"), which used to
surface as a failed tool call and a stalled-looking background turn.

The plugin registers a fallback answerer on the same Cordis waterfall:

1. it calls `next()` first, so the host (or any other answerer) always gets the
   first chance;
2. it only takes over when the chain rejects with `NO_PROVIDER` **and** the
   asking agent is not the attached session — a foreground failure is never
   masked;
3. it parks the request, marks the row waiting (green `●` + `待回答`), and keeps
   the original tool call pending instead of failing it;
4. when the row is clicked and the TUI attaches to that session, the relay
   re-dispatches the same request through `userQuestions.ask()`. The host's
   answerer now claims it, the normal questionnaire / plan-review panel appears,
   and the answer resolves the parked tool call. A cancellation
   (`ASK_CANCELLED`) propagates normally, so cancelling a plan review keeps you
   in plan mode instead of producing a `NO_PROVIDER` error.

The relay is deliberately a fallback, not a second question provider:

- it yields to every other answerer on every request, so once dsh-tui handles
  background questions itself it simply never parks anything;
- the `FORWARD` marker is a private Symbol, so the plugin's own listener cannot
  park its re-dispatch a second time;
- a `NO_PROVIDER` from the re-dispatch (the jump has not landed yet) keeps the
  question parked and retries; other unexpected errors stay parked, log once,
  and retry with backoff; a cancelled/aborted turn settles the parked ask;
- `relayQuestions: false` disables the whole relay.

The turn stays blocked while the question is parked, exactly like a foreground
question waiting for an answer. Jump to the row (or answer from the session
screen) to resolve it, or cancel the turn. A timed `ask_user_question` still
times out to `{ pending: true }`; the row's green dot then clears without an
answer. The question is in-memory only: if the process exits while it is
parked, the question is gone with the tool call.

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
The `waiting` / `waitingAt` flags are in-memory only: the store's field
whitelist drops them, so a restart never shows a green dot for a question whose
tool call is gone. A corrupt file is preserved as
`workspace-sidebar.json.corrupt-<epoch>` before an empty state is used.

## Limitations

- **Same process only.** The plugin folds the core agent registry
  (`ctx.agents`) and the live session event logs of this TUI process. dsh-tui
  0.17.0 exposes no cross-process roster, so conversations that only exist on
  disk are invisible until resumed.
- **Parked questions wait for a jump.** A background question keeps its turn
  blocked until you jump to the row and answer it (or cancel the turn). The
  green dot is the prompt; the question is not persisted, so a process exit
  discards it. The relay only sees this process's agents.
- **Waterfall dependency.** The relay uses dsh-tui 0.17.0's
  `user-questions/request` waterfall and yields to the host first. If a future
  host stops dispatching that event, the relay simply does nothing (the original
  `NO_PROVIDER` returns); it never patches dsh-tui.
- **Temporary panel id.** The plugin ships without a `dsh-plugin.json`
  manifest, so the host assigns a per-activation id
  (`session:actN:inbox`). That id cannot be persisted; it is re-resolved from
  `panels.list()` on every activation. Adding a verified manifest later would
  make the id stable and unlock plugin storage/decision events.
- **Transition card.** The full-screen flash is the only public-API path to a
  session switch in 0.17.0. If a direct `host.openSession`-style API appears,
  the panel will prefer it and keep the scene as a fallback.
- **New sessions need the scene too.** `+` and `n` use the same registered
  scene; without `tuiScenes` they toast "无法新建：场景服务不可用" and do
  nothing. Backgrounding a running turn creates its fresh session in the cwd
  being left, so a cross-workspace `+` hands off once more; the intermediate
  session is disposed immediately and (per the host's fresh-session policy) is
  not written to disk, though the host's workspace ledger may briefly record
  its id.
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
npm test        # node --test: model, tracker, store, current, jump, apply, strings, panel, questions
```

The tests cover the transition table (`running → finished → seen`), the
retention window (visibility, pruning, next-expiry), the current-session rule
(listed, pinned, never unread), the triage classes (unread, running, read) and
the ordering anchor inside them (running rows anchored to their turn start,
finished rows to their finish marker, so concurrent running conversations never
swap as their logs advance, and running workspaces keep a fixed group order as
their turns advance), subagent/no-prompt filtering, grouping, store
atomicity/corruption, the jump failure matrix, the new-session decision table
(`/new` vs workspace handoff vs `/bg`, refusals and thrown host calls), the
workspace `+`/`n` affordance (including the hidden unknown-project case and
the padded `+` after the counters), the
animated row glyphs and project counters (the header total is static), the
plan-mode spinner colour (row-only; project counters stay muted), the
per-project cap on read rows (running and
unread exempt, attached row pinned), the right-pointing project glyph,
hover-only row fill, and the
panel/scene/command/shortcut registration (including feature-detected
degradation).

The background-question tests cover the `next()`-first pass-through, parking on
`NO_PROVIDER`, the tracker-subscription re-delivery after a jump, retrying a
forwarded `NO_PROVIDER`, `ASK_CANCELLED` and aborted turns, disposal, unexpected
errors, agentless requests, the private forward marker, the foreground
`NO_PROVIDER` guard, multiple parked asks per agent, and the green-dot row /
header counts / non-persistence of the waiting flag.
