# Changelog

All notable user-facing changes to Chat Suggest will be documented here.

## [Unreleased]

### Changed

- The npm package now uses the scoped name `@sanif/pi-chat-suggest`, matching the `@sanif` namespace used by Turnstamp.

### Added

- Editable `prompt.txt` generation instructions with optional custom `promptFile` paths that are re-read for every request and opened directly by `/suggest prompt`.
- Described subcommand autocomplete and `/suggest help` guidance, including an immediate keyboard-navigable subcommand menu on the first Tab after a uniquely matched partial `/suggest` or `/summary` command.

## [0.1.0] - 2026-08-11

### Added

- Dimmed ghost suggestions rendered directly inside Pi's prompt editor while preserving previously configured custom editors.
- Tab autocomplete, Up/Down alternative previews, Enter acceptance, and Esc/typing dismissal.
- Send-ready next-input predictions that directly answer agent questions and reduce unambiguous requested actions to one exact input.
- Branch-aware cached suggestions and optional Chat Summary context.
- Global and trusted-project configuration, diagnostics, and feature toggles.

[Unreleased]: https://github.com/sanif/pi-chat-suggest/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sanif/pi-chat-suggest/releases/tag/v0.1.0
