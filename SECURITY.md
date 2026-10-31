# Security

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

The plugin targets dsh-TUI 0.17.0 and Node.js `^22.19 || >=24`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository:
<https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar/security/advisories/new>

Do not open a public issue for a vulnerability. Include the affected version,
the steps to reproduce, and the impact. A fix and a release note will be
prepared before the report is made public.

## Trust model and data access

dsh-TUI plugins run trusted-in-process with the same permissions as the TUI.
There is no sandbox. This plugin:

- reads `~/.dsh-tui/inject/servers.json` to learn which session this TUI
  process is attached to;
- reads `~/.dsh-tui/lang.json` for the saved UI language;
- observes the live agent/session events the host already exposes in memory;
- writes only `~/.dsh-tui/workspace-sidebar.json` (mode `0600` on POSIX, atomic
  rename, debounced). It contains session ids, titles, cwd, timestamps and read
  state.

It makes no network requests, sends no telemetry, runs no shell commands and
does not read session logs from disk. The state file can reveal project names
and paths; delete it if you want that data removed. Removing the plugin does not
delete it automatically.

## Scope

The plugin does not patch dsh-TUI. It only calls the public host seams the
manifest declares (`tuiPanels`, `tuiScenes`, `tuiWorkspaces`, `tuiPluginHost`,
`commands`, `tuiShortcuts`) and the `user-questions/request` waterfall. Bugs in
dsh-TUI itself should be reported to the dsh-TUI repository.
