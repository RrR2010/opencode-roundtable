# opencode-roundtable

OpenCode plugin that orchestrates **multi-agent round-robin debates**.
Agents with different personalities debate a topic turn by turn, sharing
context while keeping their own system prompts and tools.

A built-in observer automatically consolidates every debate into an
executive summary.

## Installation

### npm (recommended)

```json
{
  "plugin": ["@rrr2010/opencode-roundtable@latest"]
}
```

OpenCode auto-installs npm plugins on startup. No manual copy needed.

### Local (dev)

```bash
git clone https://github.com/opencode-ai/roundtable
cd roundtable
bun run build
npm link
```

Then add `"@rrr2010/opencode-roundtable"` to your opencode.json `plugin` array.

## Features

- **Round-robin debate** — agents speak in sequence, each seeing the full discussion history
- **Shared context** — tool outputs and discoveries are visible to all participants
- **Built-in observer** — automatically consolidates the debate into an executive summary (overridable with a specific agent)
- **Isolated session** — the debate runs in a child session, keeping the main session clean
- **File persistence** — state stored on disk, survives restarts
- **Extend mode** — continue a concluded roundtable with more rounds or a new topic
- **Agent discovery** — `available_agents` tool helps the orchestrator know which agents exist
- **Active roundtables** — `active_roundtables` tool lists current debates with status
- **TUI plugin** — badge `[RT]`, `← Back` link, `/roundtables` command
- **Auto-navigate** — optional auto-navigation between sessions on create/conclude
- **Parallel roundtables** — multiple independent debates can run simultaneously
- **User intervention** — the human can jump into the debate at any time
- **Loop detection** — Jaccard bigram similarity detects agent impasses early

## Tool API

### `roundtable()`

```typescript
roundtable({
  agents?: string[],    // Names in speaking order (min 2). Required for new debates.
  prompt: string,       // Topic or challenge. For multi-round, include per-round instructions.
  rounds?: number,      // Complete rounds (default: 1, max: 50)
  observer?: string,    // Agent for final consolidation (default: built-in)
  sessionID?: string,   // ses_xxxx — pass to extend a concluded debate
  title?: string,       // Custom title (default: auto-generated from prompt)
  observerPrompt?: string, // Override the observer consolidation prompt (e.g., "Save a detailed report to report.md")
})
```

**Returns:** `{ sessionID: string, summary: string }` after the debate concludes.

**Side effect:** injects system-level prompts into each agent's context during
the debate (role-setting, topic, turn routing, and lifecycle signals).

### `available_agents()`

```typescript
available_agents()
```

**Returns:** `"Available agents: pm, dev, rv, ..."` — a formatted string of agent names.

### `active_roundtables()`

```typescript
active_roundtables()
```

**Returns:** clickable session listings with status, e.g.:
```
Active roundtables:
- #ses_xxx · pm→dev→rv (R1/2) · debating
- #ses_yyy · pm→dev (R2/2) · consolidating
```

## Usage Examples

### Basic — one round, built-in observer

```typescript
roundtable({
  agents: ["pm", "dev"],
  prompt: "What architecture should we use?",
})
```

### Multi-round with per-round instructions

```typescript
roundtable({
  agents: ["pm", "dev"],
  prompt: "Round 1: list pros. Round 2: list cons. Round 3: propose an implementation plan.",
  rounds: 3,
})
```

### Explicit observer

```typescript
roundtable({
  agents: ["pm", "dev"],
  prompt: "Should we migrate to microservices?",
  rounds: 2,
  observer: "rv",
})
```

### Extend a concluded debate (preferred)

```typescript
roundtable({
  sessionID: "ses_abc123",
  rounds: 2,
  prompt: "Dive deeper into operational costs",
})
```

Prefer extend over starting a new roundtable — it reuses accumulated
context, saving exploration tokens. The session ID is shown in the S1
noReply message when the roundtable starts — check S1 context to find it.

### Discover agents first

```typescript
const agents = available_agents()
// agents => "Available agents: pm, dev, rv, build, plan"
roundtable({
  agents: ["pm", "dev"],
  prompt: "...",
})
```

### List active roundtables

```typescript
const active = active_roundtables()
// active => "Active roundtables:\n- #ses_xxx · pm→dev (R1/2) · debating"
```

## Configuration

Place `~/.config/opencode/roundtable.json` to override defaults:

```json
{
  "$schema": "https://raw.githubusercontent.com/opencode-ai/roundtable/main/docs/roundtable.schema.json",
  "defaultTimeoutMs": 300000,
  "loopSimilarityThreshold": 0.85,
  "toolOutputPreviewMax": 500,
  "maxRounds": 10,
  "defaultObserverPrompt": "You are an impartial roundtable observer...",
  "navigation": "link"
}
```

If the file doesn't exist, it's created automatically with defaults.

### Navigation modes

| Value | Behavior |
|-------|----------|
| `"link"` (default) | No auto-navigation. Relies on native `#ses_xxx` link rendering |
| `"auto"` | Auto-navigates S1→S2 on create, S2→S1 on conclude |
| `"none"` | No automatic navigation |

### TUI Features

The plugin registers a TUI component that provides:

- **`[RT]` badge** — shown in the sidebar for roundtable sessions
- **`← Back` link** — clickable link on child sessions, navigates to parent
- **`/roundtables` command** — slash command opens a dialog with clickable session list

## Tips

### Agent selection

Choose agents whose expertise matches the topic:

| Agent | Best for |
|-------|----------|
| `pm` | Product decisions, strategy, trade-offs |
| `dev` | Technical complexity, implementation effort |
| `rv` | Code review, docs quality, inconsistency detection |
| `plan` | Architecture planning, scope definition |
| `build` | Implementation details, execution |

### Multi-round strategy

For complex topics, structure rounds progressively:

1. **Round 1:** Explore — each agent lists their perspective
2. **Round 2:** Challenge — agents critique each other's positions
3. **Round 3+:** Converge — propose concrete solutions

Include all round instructions in the `prompt` parameter — all agents see the full agenda.

### Extend mode

- Use the session ID from the S1 noReply message when the roundtable starts
- Original topic is preserved; new prompt becomes the continuation
- Agents must be the same as the original debate (validated)
- Continue an extend for iterative refinement

## Agent colors (recommended)

```json
{
  "agent": {
    "pm":   { "color": "#3498db" },
    "dev":  { "color": "#2ecc71" },
    "rv":   { "color": "#e74c3c" },
    "plan": { "color": "#f39c12" },
    "build": { "color": "#9b59b6" }
  }
}
```

## Documentation

- [docs/SPEC.md](./docs/SPEC.md) — Full technical specification

## Requirements

- OpenCode (latest version)
- No external dependencies

## License

MIT
