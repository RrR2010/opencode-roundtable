# opencode-roundtable

OpenCode plugin that orchestrates **multi-agent round-robin debates**. Agents with different personalities debate a topic turn by turn, sharing context while keeping their own system prompts and tools.

## Features

- **Round-robin debate** — agents speak in sequence, each seeing the full discussion history
- **Shared context** — tool outputs and discoveries are visible to all participants
- **Built-in observer** — automatically consolidates the debate into an executive summary (overridable with a specific agent)
- **Isolated session** — the debate runs in a child session, keeping the main session clean
- **Extend mode** — continue a concluded roundtable with more rounds or a new topic
- **Agent discovery** — `available_agents` tool helps the orchestrator know which agents exist
- **Parallel roundtables** — multiple independent debates can run simultaneously
- **User intervention** — the human can jump into the debate at any time

## Quick Start

1. Place `roundtable.ts` in `~/.config/opencode/plugins/`
2. Restart OpenCode (or reload plugins)
3. An agent calls `roundtable()`:

```
roundtable({
  agents: ["pm", "dev", "rv"],
  prompt: "What architecture should we use?",
})
```

## Documentation

- [docs/SPEC.md](./docs/SPEC.md) — Full technical specification
- [docs/IMPLEMENTATION.md](./docs/IMPLEMENTATION.md) — Phased implementation plan

## Requirements

- OpenCode (latest version)
- No external dependencies

## License

MIT
