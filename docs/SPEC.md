# Roundtable Plugin — Technical Spec

OpenCode plugin that orchestrates **multi-agent round-robin debates** with
isolated sessions, shared context between debaters, a built-in observer
(with override), and extension support.

---

## Table of Contents

- [1. Philosophy](#1-philosophy)
- [2. Architecture](#2-architecture)
- [3. Tool API](#3-tool-api)
- [4. Lifecycle](#4-lifecycle)
- [5. States & Persistence](#5-states--persistence)
- [6. History & Context](#6-history--context)
- [7. Edge Case Handling](#7-edge-case-handling)
- [8. Observer](#8-observer)
- [9. Extend Mode](#9-extend-mode)
- [10. Navigation & TUI](#10-navigation--tui)
- [11. Plugin Structure](#11-plugin-structure)
- [12. Tests & Validation](#12-tests--validation)
- [13. Glossary](#13-glossary)
- [14. References](#14-references)

---

## 1. Philosophy

A roundtable simulates a **panel discussion** where experts from different
areas debate a topic. Each participant keeps their own personality (system
prompt, tools, temperature, color) but shares the same discussion history.

### Principles

1. **Clean slate on entry** — the roundtable session starts fresh, without
   baggage from the original conversation.
2. **Shared context between debaters** — everyone sees the same discussion
   history, including previous tool calls and outputs.
3. **Isolated personalities** — each agent keeps its own system prompt,
   tools, and configuration. No "personality merging".
4. **Separate orchestrator** — whoever invokes the roundtable does not
   participate; they only receive the result at the end.
5. **Default observer** — the plugin has a built-in observer that always
   consolidates the debate at the end. The orchestrator may override it
   with a specific agent.
6. **Extensible** — roundtables can be continued with additional rounds.
7. **File persistence** — state survives restarts via JSON files on disk.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  MAIN SESSION (S1)                                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  builder/architect: roundtable({agents, prompt, rounds, observer?})│  │
│  └────────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         │ plugin creates                                         │
│         ▼                                                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ROUNDTABLE SESSION (S2) — parentID: S1                    │  │
│  │                                                            │  │
│  │  [parentID on session create]                                         │  │
│  │  [agent:planner]  Round 1 — planner responds               │  │
│  │  [agent:developer] Round 1 — developer responds (sees history)│  │
│  │  [agent:reviewer]  Round 1 — reviewer responds              │  │
│  │  ... N rounds ...                                           │  │
│  │  [observer]  Consolidated summary                           │  │
│  │  [noReply] ━━━ Roundtable Concluded ━━━ (delimiter)        │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         │ plugin resolves pending promise with summary            │
│         ▼                                                        │
│  [noReply] ⚙ Roundtable started — #S2 • agents • N round(s)      │
└──────────────────────────────────────────────────────────────────┘
```

### Session relationship

- **S1 (Main):** where the user interacts. The session that calls `roundtable()`.
- **S2 (Roundtable):** created via `session.create({ parentID: S1 })`. Child
  sessions use SubagentFooter natively and are hidden from the sidebar.
- The plugin listens to events from BOTH: `session.idle` on S2 for sequencing,
  `session.deleted` on S1 or S2 for cleanup.

### Execution model (event-driven)

The OpenCode V2 server operates **asynchronously by design**:

1. `session.prompt()` returns immediately with an `Admitted` record
2. The agent execution loop runs in the background
3. When processing finishes, a `session.idle { sessionID }` event is emitted
4. The plugin listens to these events to advance the round-robin

This makes the roundtable **native to OpenCode's model** — no polling or
blocking required.

### Why `session.create()` and not `session.fork()`?

`fork()` copies ALL history from the current session, including tool calls,
user conversation, etc. This pollutes the roundtable context.

`create()` starts from scratch. The plugin builds the debate history manually,
including only what matters.

### File-based persistence (not META blocks)

State is stored in JSON files at `~/.config/opencode/roundtable-states/<sessionID>.json`.
The plugin **no longer** uses `[ROUNDTABLE META]` message blocks in S2.

| Function | Purpose |
|----------|---------|
| `saveStateFile(state)` | Writes state to disk |
| `loadStateFile(sessionID)` | Reads state from disk (with validation) |
| `deleteStateFile(sessionID)` | Removes state file on cleanup |
| `listStateFiles()` | Lists all session IDs with state files |

On startup, the plugin runs `scanOrphanRoundtables()` which loads all state
files into the in-memory `states` Map.

---

## 3. Tool API

### Roundtable tool

```typescript
roundtable({
  agents?: string[],            // Names in speaking order (min 2). Required for new debates.
  prompt: string,               // Topic/challenge. For multi-round, include per-round instructions.
  rounds?: number,              // Complete rounds (default: 1, max: 50)
  observer?: string,            // Agent for final consolidation (default: built-in)
  sessionID?: string,           // ses_xxxx — pass to extend a concluded roundtable
  title?: string,               // Custom title (auto-generated if omitted)
  observerPrompt?: string,      // Override the observer consolidation prompt entirely
})
```

**Returns:** `{ sessionID: string, summary: string }` after the debate concludes.

**Side effect:** injects system-level prompts into each agent's context during
the debate (role-setting, topic, turn routing, and lifecycle signals).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agents` | `string[]` | No* | — | Agent names in speaking order (min 2, schema `minItems:2`). Required for new debates; omit when extending |
| `prompt` | `string` | Yes | — | Topic/challenge. For multi-round, include per-round instructions. All agents see the full agenda |
| `rounds` | `number` | No | `1` | Number of complete rounds (schema `minimum:1`, `maximum:50`) |
| `observer` | `string` | No | `built-in` | Agent name for final consolidation. Observer does not debate — it summarizes after all rounds |
| `sessionID` | `string` | No* | — | Session ID (format: `ses_xxxx`). Pass to extend a concluded roundtable. Omit (and pass `agents`) for a fresh debate |
| `title` | `string` | No | Auto | Custom title (max 200 chars). Auto-generated as `"(Roundtable) - {first 60 chars of prompt, truncated at word boundary}"` if omitted |
| `observerPrompt` | `string` | No | — | Overrides the default observer consolidation prompt. Use to control format — e.g., `"Output as JSON"`, `"Save a detailed report to report.md"`, `"Focus only on technical decisions"` |

### Available agents tool

```typescript
available_agents()
```

**Returns** a formatted list of configured agent names:

```
Available agents: planner, developer, reviewer, architect, builder
```

### Active roundtables tool

```typescript
active_roundtables()
```

**Returns** a formatted list of active roundtables with text session IDs for programmatic use (NOT clickable links). Only the `/roundtables` TUI command has clickable session navigation.

```
Active roundtables:
- #ses_xxx · planner→developer→reviewer (R1/2) · debating
- #ses_yyy · planner→developer (R2/2) · consolidating
```

Each entry shows session ID, agents in speaking order, current round, and phase
status (`debating`, `consolidating`, or `concluded`).

### Mode inference

The tool infers the operation mode from the presence of `sessionID`:
- **No `sessionID`** → starts a fresh debate (requires `agents`)
- **`sessionID` present** → continues a concluded roundtable (uses stored agent config)

Passing both `agents` and `sessionID` returns an error.

### Return value (tool execute)

The tool blocks until the debate concludes (via a pending Promise) and returns
a string result:

```
━━━ Roundtable Concluded ━━━
Topic: {prompt}
Participants: {agents}

── Planner (Round 1) ──
{response}
  • toolName → {outputPreview}
...
```

If an error occurs (invalid agents, session not found, etc.) the tool returns
an error string prefixed with `"Error:"`. The tool never hangs — error returns
are immediate.

---

## 4. Lifecycle

### Full flow (fresh debate)

```
PHASE 1 — INITIALIZATION
─────────────────────────
  1. Orchestrator agent calls roundtable()
  2. Plugin validates agents against ctx.client.app.agents()
  3. Plugin creates S2 via session.create({ parentID: S1, title }) — title is
     "(Roundtable) - {prompt[:57]}..." or custom title
  4. Plugin stores initial state in in-memory Map + saveStateFile()
  5. Plugin sends first prompt to agents[0] via session.prompt({agent})
     (Prompt returns immediately — LLM runs in background)
  6. Plugin injects noReply in S1: ⚙ Roundtable started — #S2 • agents • N round(s)
  7. Plugin injects [...]
  8. If navigation === "auto", auto-navigate to S2
  9. Plugin shows toast "Roundtable started in #S2"
  10. Tool execute blocks with pending Promise

PHASE 2 — DEBATE (repeats for each round)
──────────────────────────────────────────
  11. agents[i] finishes → session.idle fires on S2
  12. Plugin reads response with session.messages(S2)
  13. Plugin extracts text + tool call summaries
  14. Plugin appends HistoryEntry to state.history
  15. Plugin calls saveStateFile() after each turn
  16. Plugin checks detectLoop() — if True, finalizes early
  17. Plugin decides next step:
      a) Still have agents in this round? → agents[i+1], sendToAgent()
      b) Round complete + more rounds left? → agents[0], round++, sendToAgent()
      c) All rounds complete? → PHASE 3

  Session title updates dynamically during debate:
  ⚡ "prompt..." · planner→developer→reviewer (R1/2 · ↑ #S1)

PHASE 3 — OBSERVER
──────────────────
  18. Plugin decides which observer to use:
      a) Explicit observer? → sends full prompt to that agent
      b) Default observer? → sends DEFAULT_OBSERVER_PROMPT to S2
  19. Observer consolidates → session.idle
  20. Plugin extracts summary → appends to history, saves file
  21. phase = "done"

PHASE 4 — FINALIZATION
──────────────────────
  22. Plugin builds consolidated summary from full history
  23. Plugin resolves the pending Promise with the summary
  24. Plugin injects delimiter noReply in S2:
      "━━━ Roundtable Concluded ━━━
       Messages below this line are not part of the original debate.
       The result was consolidated in the main session."
  25. Plugin updates S2 title: ⚡ "prompt..." · planner→developer→reviewer ✓
  26. Plugin calls saveStateFile() with final state
  27. If navigation === "auto", auto-navigate back to S1
  28. Plugin shows toast "Roundtable concluded"
  29. Plugin clears in-memory state for S2
```

### Flow (extend)

```
  1. Orchestrator calls roundtable({sessionID, rounds, prompt})
  2. Plugin validates session exists via session.get()
  3. Plugin loads serialized state via loadStateFile(sessionID)
  4. Plugin validates phase was "done" and agents match
  5. Plugin creates NEW state with:
     - accumulated rounds (totalRounds += new_rounds)
     - preserved history + errors
     - extended prompt via buildExtendedPrompt()
     - phase = "active"
  6. Plugin stores new state in Map + saveStateFile()
  7. Plugin updates S2 title with new round info
  8. Plugin injects noReply in S1: ⚙ Roundtable extended — #S2 • +N round(s)
  9. Plugin sends extended prompt to agents[0]
  10. Continues normal PHASE 2 flow
```

---

## 5. States & Persistence

### Roundtable state machine

```
          ┌────────────┐
          │  ACTIVE    │  (debate in progress)
          └─────┬──────┘
                │ all rounds complete
                ▼
          ┌────────────┐
          │ OBSERVING  │  (observer — built-in or explicit — always runs)
          └─────┬──────┘
                │ observer summarizes
                ▼
          ┌────────────┐
          │   DONE     │
          └────────────┘

At any state:
          │ session.deleted / fatal error
          ▼
      ┌────────────┐
      │  ABORTED   │
      └────────────┘
```

> **Note**: `OBSERVING` **always** runs. The built-in default observer
> guarantees every debate produces a consolidated summary at the end.

### In-memory state type

```typescript
interface RoundtableState {
  // Identification
  sessionID: string           // S2
  parentSessionID: string     // S1

  // Config
  agents: string[]
  totalRounds: number
  observer: "built-in" | string   // "built-in" = plugin default observer
  prompt: string

  // Progress
  currentRound: number        // 0-indexed
  currentAgentIndex: number   // 0-indexed
  currentGeneration: number   // incremented each turn, used for timeout staleness

  // Data
  history: HistoryEntry[]
  errors: string[]
  createdAt: number
  lastProcessedMsgId?: string     // prevents duplicate processing
  observerPrompt?: string         // overrides the default observer prompt
}

type Phase = "active" | "observing" | "done" | "aborted" | "pending"

interface HistoryEntry {
  agent: string
  round: number
  response: string           // plain text of the response
  toolCalls: ToolCallSummary[]   // tool names + output previews
  hasError: boolean
}

interface ToolCallSummary {
  toolName: string
  outputPreview: string      // first N chars of output (configurable, default 500)
}
```

### File-based persistence

State is persisted as JSON files at:

```
~/.config/opencode/roundtable-states/<sessionID>.json
```

The directory is determined by `$XDG_CONFIG_HOME` (if set) or
`~/.config/opencode/roundtable-states/`.

Key behaviors:
- `saveStateFile()` is called after state mutations (turn complete, phase
  change, error, etc.)
- `loadStateFile()` validates required fields before returning
- `deleteStateFile()` is called when a session is deleted
- `listStateFiles()` lists all `.json` files in the directory
- On plugin startup, `scanOrphanRoundtables()` loads all state files into
  the in-memory `states` Map for recovery and active listing

### In-memory maps

```typescript
const states = new Map<string, RoundtableState>()
const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>()
const pendingResults = new Map<string, { resolve: (output: string) => void }>()
```

- `states` — all known roundtables, synced from files on startup
- `timeoutHandles` — per-agent timer handles for timeout enforcement
- `pendingResults` — Promise resolvers that unblock the `roundtable()` tool

---

## 6. History & Context

### Content sent to each agent

Each time the plugin passes the turn (via `buildAgentPrompt`), it sends a
fluent message with:

```
You are participating on a multi-agent discussion — N round(s), speaking order: A → B → C.

Topic: {prompt}

--- Round N of N — agent's turn ---
This is the final turn — wrap up your arguments. (last turn only)
```

Key points:
- No `[RULES]`/`[CONSTRAINT]`/`[Topic]` tags — the prompt reads naturally
- Nested roundtable prevention is handled at the tool level (`states.has()`),
  not via prompt text
- The first turn includes the full context; subsequent turns only get the
  round header
- The "final turn" hint is added on the last agent of the last round

### What the plugin includes in history

The accumulated history contains **everything relevant for consolidation**:

- `TextPart.text` — agent's textual response
- `ToolCallSummary` — tool name + **output preview** (configurable, default 500 characters).
  If `developer` ran `ls src/`, the next agent sees the discovered directory structure.
- Errors and failures are tracked per entry

### What the plugin does NOT include in history

- `ReasoningPart.text` — agent's internal reasoning (stays in S2 session)
- `StepStartPart` / `StepFinishPart` — execution metadata

### History visibility to agents

History is accumulated server-side in the plugin state. It is NOT currently
injected into subsequent agent prompts — each agent only sees its current
turn's context. The full history is used by the observer for consolidation
and appears in the final summary returned to S1.

---

## 7. Edge Case Handling

### 7.1 Agent failure (provider error)

```
session.error on S2 with agent = currentAgent
  → Logs error in state.errors[]
  → Advances to next agent (or next round, or aborts)
  → Toast: "agent failed on Round N. Skipping to next."
  → If all agents fail → aborts with error
```

### 7.2 User closes S2 (session.deleted on S2)

```
session.deleted on S2 (deletedSessionID === state.sessionID)
  → Deletes state file
  → phase = "aborted"
  → Builds partial consolidated summary
  → Resolves pending Promise with:
    "[Roundtable interrupted — session closed.
     Partial history up to interruption:]
     {partial summary}"
  → Toast: "Roundtable interrupted"
  → Clears in-memory state
```

### 7.3 User closes S1 (session.deleted on S1)

```
session.deleted on S1 (deletedSessionID === state.parentSessionID)
  → Deletes state file
  → phase = "aborted"
  → Aborts S2 via session.abort({path:{id:S2}})
  → Clears in-memory state
```

### 7.4 User types a message in S2 during the debate

S2 is a visible and interactive session. If the user switches to S2
and types something:

- The message enters S2's context
- If the current agent is still processing, the user's message will be
  processed after the agent finishes
- The plugin continues the round-robin — the user's message becomes part
  of the context

**Behavior**: natural and desired. The user can intervene in the debate.

### 7.5 Debate loop (agents repeating arguments)

After each turn, the plugin checks similarity between the latest response
and the previous one using **Jaccard similarity of bigrams (character pairs)**:

```
bigrams = set of all consecutive character pairs in cleaned text
similarity = |bigrams(current) ∩ bigrams(previous)| / |bigrams(current) ∪ bigrams(previous)|

if similarity > threshold (default 0.85):
  → "Loop detected — agents reached an impasse"
  → phase = "done", finalizes early with partial result
```

**Why Jaccard bigrams?**
- Purely computational (no LLM calls or embeddings needed)
- Zero external dependencies
- Reasonable for detecting textual argument repetition
- Threshold is configurable via `loopSimilarityThreshold` in config

### 7.6 Agent timeout

- Each agent turn has a configurable timeout (default **5 minutes**)
- Set `defaultTimeoutMs: -1` for no timeout (agent can run indefinitely)
- Implemented via `setTimeout` + generation counter (stale check)
- If it expires: `session.abort({path:{id:S2}})` → skip to next agent
- Timeout handle is tracked in `timeoutHandles` map

### 7.7 Multiple simultaneous roundtables

Each roundtable has its own state in `Map<sessionID, RoundtableState>`.
They are independent. The plugin allows multiple roundtables running in
parallel.

### 7.8 State recovery after restart

If OpenCode restarts mid-roundtable:
- In-memory state is lost
- State JSON files persist on disk at `~/.config/opencode/roundtable-states/`
- S2 session remains in the database

**Recovery**: on initialization, the plugin runs `scanOrphanRoundtables()`:
```
1. List all .json files in roundtable-states directory
2. For each file, loadStateFile() and add to in-memory states Map
3. Log: "scanOrphanRoundtables: N state(s) loaded, M error(s)"
```

Recovered states with `phase: "active"` become visible via `active_roundtables()`
but the debate does not auto-resume — the user must decide whether to extend
or close the session.

### 7.9 Compaction during a roundtable

The plugin registers an `experimental.session.compacting` hook (currently a
no-op). Future phase 4 will re-inject critical state during compaction to
prevent data loss.

### 7.10 Human message in S2 after conclusion

After `phase = "done"` (roundtable concluded):
- The plugin has already injected the `━━━ Roundtable Concluded ━━━`
  delimiter in S2
- The plugin's `processNextTurn` checks `state.phase === "done" | "aborted"`
  and returns early — it no longer processes events for this session
- If the user types in S2, OpenCode responds normally with the session's
  default agent
- The response **does not** alter the result already consolidated in S1

```
[noReply] ━━━ Roundtable Concluded ━━━
          Messages below this line are not part of the original debate.
          The result was consolidated in the main session.
── You ──
(conversation can continue here, but the plugin no longer
 manages this session.)
```

**Behavior**: natural and transparent. S2 becomes a regular session after
the roundtable concludes.

### 7.11 Nested roundtables (guard)

Nested roundtables occur when an agent inside S2 calls the `roundtable()`
tool, attempting to create S2.1 (child of S2). This is prevented by two
mechanisms:

**Primary: in-memory `states` check**

```
In the tool's execute function:
  states.has(toolCtx.sessionID)
```

The `states` Map is populated by `startNewRoundtable()` as soon as S2 is
created. Since the plugin's module-level variables are shared across the
event handler and tool execution (within the same Bun process), any tool
call from inside S2 will find S2 in the `states` Map and be rejected:

```
Cannot nest roundtables. You are already inside roundtable #S2. Wait for
it to complete before starting another.
```

This check runs before any other logic in the `execute` function, making
it a zero-cost guard that fires immediately. There is no secondary prompt-level
guard — the runtime check is sufficient.

**Why not use `session.get().parentID`?**
The opencode server API (`session.get()`) does NOT return the `parentID`
field in its response, even though it is set during session creation.
Only the `title` field is reliably available via the API. The in-memory
`states` Map is the correct approach because it lives in the same process
as the tool execution.

**Note for developers:** When making changes, ensure that:
1. `states.set(sessionID, state)` is called BEFORE `sendToAgent()` in
   `startNewRoundtable()`.
2. `states.delete(sessionID)` is called in `finalizeRoundtable()`.
3. Both cache directories are updated when syncing builds:
   `@rrr2010/opencode-roundtable` and `@rrr2010/opencode-roundtable@latest`.

### 7.12 Zod schema bug (`.optional()` / `.default()`)

Tool arguments using `.optional()` or `.default()` on Zod schemas cause
a runtime error in OpenCode's tool argument processing:

```
undefined is not an object (evaluating 'mo.output')
```

**Fix**: Remove all `.optional()` and `.default()` calls from tool arg
schemas. Handle defaults manually in the `execute()` function using `??`.

```typescript
// ❌ CAUSES mo.output
sessionID: tool.schema.string().optional().describe("..."),
rounds: tool.schema.number().min(1).default(1).describe("..."),

// ✅ WORKS
sessionID: tool.schema.string().describe("..."),
rounds: tool.schema.number().min(1).describe("..."),
```

And inside `execute`:
```typescript
const rounds = (args.rounds as number) ?? 1
```

### 7.13 Error during observer phase

If the observer fails (provider error in `OBSERVING` phase):
- `handleAgentError` sets `phase = "aborted"`
- Calls `finalizeRoundtable()` which builds partial summary from existing
  history and resolves the pending Promise

---

## 8. Observer

### Function

The observer **always consolidates** the debate at the end. It does not
participate in rounds — it enters after all rounds are complete to produce
an executive summary.

### Default observer (built-in)

If the orchestrator does not specify `observer`, the plugin uses a built-in
observer with the following prompt:

```
DEFAULT_OBSERVER_PROMPT = `
You are an impartial roundtable observer.
Consolidate the debate below into:

1. **Executive summary** (2-3 sentences)
2. **Key points** raised by each participant
3. **Decisions or convergences** reached
4. **Remaining open questions**
5. **Suggested next steps**

Debate:
{full_history}
`
```

This prompt is sent to the S2 session itself (no specific agent), using the
session's default model/provider.

### Explicit observer (override)

If the orchestrator passes `observer: "reviewer"`, the plugin:
1. Builds a similar prompt, but with `Your role: reviewer. Provide an executive summary...`
2. Sends via `session.prompt({ agent: "reviewer" })` on the S2 session
3. The `reviewer` agent responds with its own tools and personality

### Flow

```
1. All rounds complete → transition to OBSERVING
2. Plugin decides:
   a) Explicit observer? → sends to that agent
   b) Default observer? → sends DEFAULT_OBSERVER_PROMPT to S2
3. Observer responds → session.idle
4. Plugin extracts text, appends to history, saves state file
5. phase = "done", finalizeRoundtable() called
```

### Observer prompt is configurable

**Per-call override (runtime):** pass `observerPrompt` in the `roundtable()` call.
This completely replaces the observer prompt for that debate:

```
roundtable({
  agents: ["planner", "developer", "reviewer"],
  prompt: "...",
  observerPrompt: "Output only a single emoji that captures the discussion",
})
```

The `observerPrompt` is persisted in the state file and carried over on extend
(unless a new `observerPrompt` is provided in the extend call).

**Static override (config):** the `defaultObserverPrompt` field in
`roundtable.json` replaces the built-in template for all debates that don't
provide a per-call `observerPrompt`.

---

## 9. Extend Mode

Prefer extend over starting a new roundtable — it reuses accumulated
context, saving exploration tokens and preserving the full discussion
history.

### Usage

```typescript
roundtable({
  sessionID: "ses_abc123",     // Original S2 ID
  rounds: 2,
  prompt: "Dive deeper into operational costs",
})
```

### Prompt semantics in extend mode

The `prompt` parameter in `extend` mode can be:

| Intent | Example | Effect |
|--------|---------|--------|
| **Continuation** | "Debate more about X" | New prompt is sent as a complement to the original topic. `final_prompt = "Original topic: {original.prompt}\n\nContinuation: {prompt}"` |
| **New topic** | "Now plan Y" | New prompt replaces the topic, but previous history is preserved as context. `final_prompt = "Previous discussion history preserved. Original topic was: ...\n\nNew challenge: {prompt}"` |

The plugin infers intent heuristically: if the prompt starts with
"Debate more", "Continue", "Dive deeper", "Expand on", "Elaborate",
"Further discuss", or "Keep debating" → continuation. Otherwise → new topic.

### Flow

```
 1. Plugin validates session exists via session.get(sessionID)
 2. Plugin loads state from file via loadStateFile(sessionID)
 3. Plugin validates:
    a) phase === "done" (cannot extend active/observing)
    b) agents match (if passed)
    c) all original agents still exist on server
 4. Creates NEW state with:
    - same sessionID, parentSessionID, agents, observer
    - totalRounds += new_rounds (accumulative)
    - history + errors from original
    - extended_prompt from buildExtendedPrompt()
    - phase = "active"
 5. Stores new state in Map + saveStateFile()
 6. Updates S2 title with new round info
 7. Injects noReply in S1: ⚙ Roundtable extended — #S2 • +N round(s)
 8. Sends extended_prompt to agents[0]
 9. Continues normal PHASE 2 flow
```

### Constraints

- Only works if S2 still exists (was not deleted)
- Only works if original phase was "done"
- Agents and observer must be the same as the original roundtable (agents
  are optional in the request, but if provided they must match exactly)
- Previous discussion history is always preserved
- If the original roundtable used an explicit observer, the extend also uses
  it (observer type is stored in state file)

### Stuck session recovery

If an extend is interrupted mid-way (TUI freeze, process kill, etc.), the
state file has `phase: "active"` but no agent is running. The next extend
call returns an error indicating the session is in an invalid state.
The user must manually close the S2 and start fresh.

---

## 10. Navigation & TUI

### Navigation modes

Configurable via `navigation` in `roundtable.json`:

| Mode | Value | Behavior |
|------|-------|----------|
| **Link** | `"link"` (default) | No auto-navigation. Relies on native `#ses_xxx` link rendering in the TUI for user to navigate manually |
| **Auto** | `"auto"` | Auto-navigates S1 → S2 on create, and S2 → S1 on conclude. Uses `navigateToSession()` helper which calls `tui.publish({ type: "tui.session.select" })` |
| **Disabled** | `"none"` | No automatic navigation. No link rendering relied upon |

`navigateToSession()` tries `ctx.client.tui.selectSession()` first, falling
back to `tui.publish({ type: "tui.session.select" })`.

### Session titles

| State | Format |
|-------|--------|
| Active (auto-generated) | `(Roundtable) - {prompt[:57]}...` |
| During debate | `⚡ "{prompt[:37]}..." · agent1→agent2 (R1/2 · ↑ #parentID)` |
| Concluded | `⚡ "{prompt[:37]}..." · agent1→agent2 ✓` |

### Compact S1 markers

Instead of verbose serialization, S1 gets minimal noReply markers:

| Event | Marker |
|-------|--------|
| Roundtable started | `⚙ Roundtable started — #ses_xxx • agents • N round(s)` |
| Roundtable extended | `⚙ Roundtable extended — #ses_xxx • +N round(s)` |

### S2 markers

| Purpose | Marker |
|---------|--------|
| Parent reference | Encoded in session metadata (`parentID`) and session title (`↑ #parent`) |

### TUI Plugin

The plugin registers a `/roundtables` slash command that opens a dialog
listing all active roundtable sessions. Clicking a row navigates to that
session. Toast notifications are also shown on start, completion, errors,
and interruptions.

| Feature | Implementation |
|---------|---------------|
| **`/roundtables` command** | `api.command.register()` — slash command opens a dialog listing all active roundtable sessions. Clicking a row navigates to it |
| **Toast notifications** | `api.client.tui.showToast()` — on start, completion, errors, and interruptions |

### TUI event-based session registry

The TUI plugin maintains a parent-child session registry using an event-driven
approach instead of polling. On initialization, it listens for `session.created`
events:

```
api.event.on("session.created", (event) => {
  const info = event?.properties?.info
  if (!info?.id) return
  const title = (info.title ?? "") as string
  if (!title.startsWith("(Roundtable)") && !title.startsWith("⚡")) return
  // Store parentID mapping in KV store
  map[info.id] = info.parentID ?? info.parent_session_id ?? ""
  saveRTMap(map)
})
```

**Filtering logic**: Only sessions whose title starts with `(Roundtable)` or `⚡`
are recorded. This ensures only active roundtable children are tracked, not
every session on the server.

**KV persistence**: The mapping is stored via `api.kv.get/set` (key `"rt-parents"`),
surviving TUI restarts. The `/roundtables` dialog reads this map and filters
entries visible from the current session via parentID matching.

This approach avoids polling `session.list()` and naturally stays in sync
as sessions are created and navigated during a roundtable's lifecycle.

### Custom tool rendering (visual feedback)

Inline tool call customization (spinner, clickable title) is **not currently
possible** via the official plugin API. The opencode session-ui package
(`@opencode-ai/session-ui`) contains `registerTool()` and `BasicTool`
but they are not exposed through the plugin SDK and are not importable
by plugins.

**What works:**
- **Toast notifications** on start, turn changes, and completion (via
  `ctx.client.tui.showToast()`)
- **`/roundtables` command** — lists all active roundtables; clicking a
  row navigates to the session
- **Native parent-child navigation** — opencode's TUI natively supports
  `ctrl+up`/`ctrl+down` to navigate between parent and child sessions
- **`toolCtx.metadata()`** — the execute function sets `{ sessionId: sid }`
  on the tool part metadata, which may be used by future or third-party
  tool renderers

### TUI appearance example

```
S1 (orchestrator):
  You: roundtable({agents:[planner,developer], rounds:2})
  Builder: ⚙ Roundtable started — #abc123
          • planner → developer • 2 round(s)
  [tool returns observer summary]
  
S2 (roundtable session):
  You are participating on a multi-agent discussion — 2 round(s), speaking order: planner → developer.

  Topic: What architecture should we use?

  --- Round 1 of 2 — planner's turn ---
  ── Planner's response ──
  ...
  --- Round 2 of 2 — developer's turn ---
  This is the final turn — wrap up your arguments. (last turn only)
  ── Developer's response ──
  ── Observer consolidation ──
  {observer's structured summary}
  ━━━ Roundtable Concluded ━━━

```



---

## 11. Plugin Structure

### Files

```
opencode-roundtable/
├── package.json              # name, version, main: dist/index.js, export ./tui
├── tsconfig.json
├── index.ts                  # Plugin entry point + tool definitions + event handler
├── src/
│   ├── types.ts              # Interfaces: RoundtableState, HistoryEntry, ToolCallSummary, etc.
│   ├── config.ts             # loadConfig, validateConfig, defaults (roundtable.json)
│   ├── state.ts              # In-memory maps + file persistence (saveStateFile, loadStateFile, etc.)
│   ├── prompts.ts            # buildAgentPrompt, buildObserverPrompt
│   ├── handlers.ts           # All orchestration logic (start, extend, process turns, finalize, errors)
│   ├── utils.ts              # detectLoop, extractResponse, buildToolSummaries, navigateToSession, etc.
│   └── tui/
│       └── tui.tsx           # TUI plugin (/roundtables command)
├── docs/
│   ├── SPEC.md
│   ├── IMPLEMENTATION.md
│   └── roundtable.schema.json
└── README.md
```

### Dependencies

None external. Only `@opencode-ai/plugin` (peer dependency of OpenCode).

### Hooks used

| Hook | Purpose |
|------|---------|
| `event` | Listens to `session.idle`, `session.error`, `session.deleted` |
| `experimental.session.compacting` | Placeholder for state preservation during compaction |
| `tool` | Defines the `roundtable`, `available_agents`, and `active_roundtables` tools |

### SDK APIs used

| API | Usage |
|-----|-------|
| `ctx.client.session.create()` | Create S2 |
| `ctx.client.session.prompt()` | Send messages to agents |
| `ctx.client.session.messages()` | Read agent responses |
| `ctx.client.session.abort()` | Abort timed-out agent |
| `ctx.client.session.update()` | Update session title |
| `ctx.client.session.get()` | Validate session exists (extend mode) |
| `ctx.client.session.list()` | Session listing (used by TUI dialog) |
| `ctx.client.tui.showToast()` | Notify user |
| `ctx.client.tui.publish()` | Auto-navigate (fallback) |
| `ctx.client.app.agents()` | Discover available agents |
| `ctx.client.app.log()` | Debug logging |

### TUI APIs used (via `@opencode-ai/plugin/tui`)

| API | Usage |
|-----|-------|
| `api.command.register()` | `/roundtables` slash command |
| `api.route.navigate()` | Navigate to child/parent sessions |
| `api.ui.dialog.replace()` | Show roundtable list dialog |
| `api.ui.toast()` | Notifications |
| `api.theme.current` | Read theme colors for custom UI |
| `api.slots.register()` | Sidebar badges and navigation links |

---

## 12. Tests & Validation

### Test scenarios

1. **Basic roundtable**: 2 agents, 1 round, default observer
2. **Explicit observer**: 3 agents, 2 rounds, observer="reviewer" consolidates
3. **Default observer**: same scenario, no observer param → uses built-in
4. **Agent failure**: provider error → skip → continue
5. **Timeout**: agent takes too long → abort + skip
6. **Loop detection**: agents repeat arguments → Jaccard > 0.85 → end debate early
7. **Session deleted**: close S2 → partial result in S1
8. **Parent deleted**: close S1 → S2 aborted
9. **Extend (continuation)**: conclude → extend with "Debate more about X"
10. **Extend (new topic)**: conclude → extend with "Now plan Y"
11. **Multiple**: 2 roundtables in parallel
12. **Compaction**: compact S2 during debate (no-op currently)
13. **User interjection**: user writes in S2 during debate → continues
14. **Post-conclusion**: user writes in S2 after done → S2 becomes normal session
15. **Startup recovery**: restart during ACTIVE → scanOrphanRoundtables detects states
16. **Invalid agent**: agents with nonexistent name → error with available list
17. **Available agents tool**: orchestrator calls `available_agents()` → gets list
18. **Active roundtables tool**: lists all active roundtables with status
19. **Navigation config**: auto-navigate on create/conclude with `navigation: "auto"`

### Acceptance criteria

- [ ] Nested roundtables are blocked with error "Cannot nest roundtables..."
- [ ] Nested guard enforced at tool level (not via prompt text)
- [ ] Removing `.optional()`/`.default()` from Zod schemas prevents `mo.output` crash
- [ ] Dev sync script copies build to both `@latest` and versioned cache dirs
- [ ] `roundtable` tool appears in the agent's tool list
- [ ] `available_agents` tool appears in the agent's tool list
- [ ] `active_roundtables` tool lists active roundtables
- [ ] S2 is created as a child of S1
- [ ] Agents speak in the specified order
- [ ] Each agent keeps its own personality
- [ ] History + tool outputs tracked in state per turn
- [ ] Default observer (built-in) consolidates the debate at the end
- [ ] Explicit observer (named agent) also works
- [ ] Final result is returned to the calling tool
- [ ] Toast notifications appear on start, error, and conclusion
- [ ] Agent errors are skipped with notification
- [ ] S2 session title updates dynamically during debate
- [ ] Session title shows `✓` on conclusion
- [ ] Extend mode resumes from state file (continuation and new topic)
- [ ] Session deletion is handled gracefully (partial result or abort)
- [ ] Loop detection works (Jaccard bigrams, configurable threshold)
- [ ] Invalid agent names return an error with the available list
- [ ] `━━━ Roundtable Concluded ━━━` delimiter appears in S2 at the end
- [ ] Post-conclusion messages in S2 do not affect the S1 result
- [ ] State files persist in `~/.config/opencode/roundtable-states/`
- [ ] Startup recovery loads state files into memory
- [ ] Navigation config respects `link`/`auto`/`none` modes
- [ ] `/roundtables` slash command opens session list dialog

---

## 13. Future ideas

### 13.1 Custom sequence mode

Instead of round-robin (`agents[]` + `rounds`), accept an explicit turn sequence:

```ts
sequence: [
  { agent: "pm",  prompt: "Planeje xyz" },
  { agent: "dev", prompt: "Implemente xyz" },
  { agent: "rv",  prompt: "Revise xyz" },
  { agent: "dev", prompt: "Corrija as saídas do rv anteriores" },
  { agent: "pm",  prompt: "Commit and push" },
],
observerPrompt: "Gere um relatório.md..."
```

Breaks the current assumptions of `currentRound` / `currentAgentIndex` as a linear
grid — would need a step-based index and per-step prompt injection via
`buildAgentPrompt`. Observer triggers after the last step. The round-robin
`mode: "roundrobin"` and the new `mode: "sequence"` could coexist as
alternatives in the same tool.

### 13.2 Configurable context sharing

Control how much of the accumulated discussion each agent sees:

| Level | Description |
|-------|-------------|
| `full` | Everything — tools + responses + thinking (current behavior) |
| `toolAndResponse` | Tool outputs + agent responses, no system/thinking |
| `responseOnly` | Only agent text responses |
| `toolOnly` | Only tool call summaries |
| `nothing` | No prior history besides the turn prompt |

Since the plugin does not control the session's message store, this would need
either (a) selective history reconstruction injected into the agent prompt, or
(b) session API support for message filtering.

### 13.3 UI progress in TUI

Show a step indicator in the session title or via TUI components:

```
[pm → dev → rv → dev → pm]
         ↑ passo atual
```

### 13.4 Callbacks / webhooks

Trigger a configured action when the roundtable concludes (e.g. write
`relatorio.md`, call an HTTP endpoint, post to Slack).

---

## 14. Glossary

| Term | Definition |
|------|------------|
| **S1** | Main session, where the user interacts |
| **S2** | Child session, where the roundtable runs |
| **Round** | One round = all agents speak once |
| **Turn** | A specific agent's turn to speak |
| **Observer** | Agent that does not debate, only summarizes |
| **Orchestrator** | Agent that called `roundtable()` |
| **History** | Accumulated discussion entries (text + tool summaries) |
| **Phase** | Current roundtable state (`active`, `observing`, `done`, `aborted`, `pending`) |
| **Extend** | Continue a concluded roundtable with more rounds |
| **noReply** | Injected message that does not trigger an AI response |
| **ToolCallSummary** | Record of a tool used by an agent: name + output preview (500 chars) |
| **Jaccard (bigrams)** | Text similarity algorithm used in loop detection: `|A∩B|/|A∪B|` over character pairs |
| **Default observer** | Built-in plugin mechanism that consolidates the debate into an executive summary without relying on an external agent |
| **State file** | JSON file at `~/.config/opencode/roundtable-states/<sessionID>.json` containing full `RoundtableState` |
| **scanOrphanRoundtables** | Startup process that loads all state files into the in-memory Map |

---

## 14. References

- [OpenCode Plugin SDK](https://opencode.ai/docs/sdk/)
- [OpenCode Plugin API](https://opencode.ai/docs/plugins/)
- [OpenCode Agent Config](https://opencode.ai/docs/agents/)
- [OpenCode SDK Types (GitHub)](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js/src)
- `@opencode-ai/sdk` types
