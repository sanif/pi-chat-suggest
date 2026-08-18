# Chat Suggest

A [Pi](https://pi.dev) extension that predicts a useful next message and displays it as subtle ghost text directly in the prompt editor.

<p align="center">
  <img src="docs/chat-suggest.png" alt="Chat Suggest showing a dimmed next-message suggestion in Pi's editor">
</p>

## What it does

- Generates send-ready suggestions after an agent response.
- Press **Tab** to accept the visible suggestion.
- Use **Up/Down** to preview alternatives and **Enter** to choose one.
- Press **Esc** or start typing to dismiss suggestions instantly.
- Preserves Pi's built-in completion behavior and existing custom editors.
- Uses Chat Summary context when available but also works independently.

## Install

```bash
pi install npm:@sanif/pi-chat-suggest
```

Or install from GitHub:

```bash
pi install git:github.com/sanif/pi-chat-suggest
```

## Usage

- `/suggest refresh` — regenerate suggestions
- `/suggest settings` — manage feature toggles
- `/suggest prompt` — open the editable generation prompt
- `/suggest help` — show all commands

Configuration is loaded from `~/.pi/agent/chat-suggest.json` and trusted project overrides from `<project>/.pi/chat-suggest.json`.

## Privacy and cost

Suggestion generation may send the latest response, compact session summary, and draft text to the configured model provider. Privacy-safe diagnostics never include that content.

## Development

```bash
bun install
bun run verify
```

## License

MIT
