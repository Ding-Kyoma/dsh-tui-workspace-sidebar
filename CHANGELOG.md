# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-31

### Added

- A full Simplified Chinese README (`README.zh-CN.md`) beside the English
  `README.md`, with language links in both directions and a Chinese quick
  start on the npm page.
- A `Languages` section documenting the English/Chinese UI, the resolution
  order (plugin `lang` config > live host language > `DSH_TUI_LANG` >
  `~/.dsh-tui/lang.json` > OS locale), and the labels that are registered
  when the plugin activates.
- Regression tests for dictionary key/type/`{{placeholder}}` parity, the
  language-resolution precedence, and the panel rendered in English as well
  as Chinese.

### Changed

- `README.zh-CN.md` is included in the npm tarball, and the release guard
  checks that both READMEs ship and link to each other.
- No runtime behaviour changed; the panel has been bilingual since 0.1.0.

[0.1.1]: https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar/compare/v0.1.0...v0.1.1

## [0.1.0] - 2026-10-31

### Added

- Right-side inbox panel for dsh-TUI, grouped by workspace: running sessions,
  finished-but-unread conversations, parked questions, and recently read rows.
- One-week retention (`retentionHours`, capped at 30 days), a per-project read
  cap that adapts to the panel height, stable triage ordering, and an
  atomic/quarantining JSON state file.
- Click-to-jump and new-session actions through the public scene seam, plus the
  `/ws` command and the configurable `alt+w` shortcut.
- Observation of foreground `ask_user_question` / `exit_plan_mode` requests and
  a fallback answerer for background asks; a parked question is released only
  when its row is opened from the inbox.
- dsh-plugin v0.15 manifest with the `commands.dsh/v1alpha1#Command` contract,
  the `workspace-sidebar.ws` command declaration and its `commands.invoke`
  permission.
- Cordis `Config` schema with the documented defaults, an offline release
  guard, CI on Node 22.19/24, and a tag-driven npm publish workflow.

### Release

- Published to npm as `dsh-tui-workspace-sidebar@0.1.0` on 2026-10-31. This
  first version was bootstrapped with a manual publish; later versions are
  published by the tag-driven workflow using npm trusted publishing.

### Known limitations

- The roster is per TUI process; conversations that only exist on disk are not
  listed until resumed.
- Parked background questions are in-memory only and wait for an explicit inbox
  click.
- The plugin depends on dsh-TUI 0.17.0's `user-questions/request` waterfall and
  public panel/scene/command seams.
- 0.1.0 has no npm provenance attestation because it was bootstrapped with a
  manual publish; later releases use trusted publishing and include provenance.

[0.1.0]: https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar/releases/tag/v0.1.0
