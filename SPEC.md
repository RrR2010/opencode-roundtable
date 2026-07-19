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
- [5. States](#5-states)
- [6. History & Context](#6-history--context)
- [7. Edge Case Handling](#7-edge-case-handling)
- [8. Observer](#8-observer)
- [9. Extend Mode](#9-extend-mode)
- [10. Visual Interface](#10-visual-interface)
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

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  MAIN SESSION (S1)                                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  build/plan: roundtable({agents, prompt, rounds, observer?})│  │
│  └────────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         │ plugin creates                                         │
│         ▼                                                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ROUNDTABLE SESSION (S2) — parentID: S1                    │  │
│  │                                                            │  │
│  │  [noReply] Debate rules / serialized state                 │  │
│  │  [agent:PM]  Round 1 — PM responds                         │  │
│  │  [agent:DEV] Round 1 — DEV responds (sees history)          │  │
│  │  [agent:RV]  Round 1 — RV responds                          │  │
│  │  ... N rounds ...                                           │  │
│  │  [observer]  Consolidated summary                           │  │
│  │  [noReply] ━━━ Roundtable Concluded ━━━ (delimiter)        │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│         │                                                        │
│         │ plugin injects summary                                  │
│         ▼                                                        │
│  [noReply] Consolidated result                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Session relationship

- **S1 (Main):** where the user interacts. The session that calls `roundtable()`.
- **S2 (Roundtable):** created via `session.create({ parentID: S1 })`. Appears
  as a child session in navigation (`<Leader>+Right/Left`).
- The plugin listens to events from BOTH: `session.idle` on S2 for sequencing,
  `session.deleted` on S1 or S2 for cleanup.

### Execution model (event-driven)

The OpenCode V2 server already operates **asynchronously by design**:

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

---

## 3. Tool API

### Roundtable tool

```typescript
roundtable({
  agents: string[],             // Agent names in speaking order (min 2)
  prompt: string,               // Topic/challenge to debate
  rounds?: number,              // Number of complete rounds (default: 1)
  observer?: string,            // Agent that consolidates the summary (optional — default: plugin built-in)
  mode?: "new" | "extend",      // Operation mode (default: "new")
  sessionID?: string,           // Session to extend (only for mode:"extend")
  title?: string,               // Custom title for S2 (default: "Roundtable: A vs B · N round(s)")
})
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agents` | `string[]` | Yes | — | Agent names in speaking order (min 2). Validated against `ctx.client.app.agents()` |
| `prompt` | `string` | Yes | — | Topic/challenge to debate |
| `rounds` | `number` | No | `1` | Number of complete rounds |
| `observer` | `string` | No | `built-in` | Agent name for final consolidation. If omitted, uses the plugin's built-in observer |
| `mode` | `"new" \| "extend"` | No | `"new"` | Operation mode |
| `sessionID` | `string` | No* | — | S2 session ID to extend (required if `mode: "extend"`) |
| `title` | `string` | No | `"Roundtable: {agents} · {rounds} round(s)"` | Custom title for the child session |

### Available agents tool

A complementary tool lets the orchestrator discover which agents exist:

```typescript
available_agents()
```

**Returns** a formatted list of configured agent names:

```
Available agents: pm, dev, rv, plan, build
```

This helps the orchestrator (e.g., `build`) know which names to pass in
`agents` when calling `roundtable()`.

### Modes

| Mode | Description |
|------|-------------|
| `new` | Creates a new S2 session and starts the debate |
| `extend` | Continues a concluded roundtable (requires `sessionID`) |

### Usage examples

```typescript
// Basic: 1 round, built-in observer (default)
roundtable({
  agents: ["pm", "dev", "rv"],
  prompt: "What architecture should we use for the payments module?",
})

// Explicit observer and 2 rounds
roundtable({
  agents: ["pm", "dev"],
  prompt: "Should we migrate to microservices?",
  rounds: 2,
  observer: "rv",               // uses agent "rv" as observer
})

// Built-in observer with custom title
roundtable({
  agents: ["pm", "dev"],
  prompt: "Which ORM should we use?",
  title: "Debate: ORM vs Raw SQL",
})

// Extending a previous roundtable
roundtable({
  mode: "extend",
  sessionID: "abc123",
  rounds: 2,
  prompt: "Dive deeper into operational costs",
})

// Discovering agents before calling roundtable
// Orchestrator can call available_agents() first, then:
roundtable({
  agents: ["pm", "dev"],    // now it knows these names exist
  prompt: "...",
})
```

### Return value (tool execute)

```typescript
"Roundtable started in child session #abc123 (PM → DEV → RV · 2 rounds)"
```

The response also includes the list of available agents if any name is invalid
(validation happens in Phase 1 — Initialization, step 2).

---

## 4. Lifecycle

### Full flow (mode: "new")

```
PHASE 1 — INITIALIZATION
─────────────────────────
  1. Orchestrator agent (e.g., build) calls roundtable()
  2. Plugin validates agents against ctx.client.app.agents()
  3. Plugin creates S2 via session.create({ parentID: S1, title })
  4. Plugin serializes initial state as noReply in S2
  5. Plugin sends initial prompt to agents[0] via session.prompt({agent})
     (Prompt returns immediately — LLM runs in background)
  6. roundtable() returns confirmation
  7. session.idle fires on S1 (no active S1 state → ignored)

PHASE 2 — DEBATE (repeats for each round)
──────────────────────────────────────────
  8. agents[i] finishes → session.idle fires on S2
  9. Plugin reads response with session.messages(S2)
  10. Plugin accumulates into internal history[] (text + tool outputs)
  11. Plugin decides next step:
      a) Still have agents in this round? → agents[i+1]
      b) Round complete + more rounds left? → agents[0], round++
      c) All rounds complete? → PHASE 3 (observer always runs)

PHASE 3 — OBSERVER
──────────────────
  12. Plugin decides which observer to use:
      a) Explicit observer? → sends full history to that agent
      b) Default observer? → sends to S2 with built-in plugin prompt
  13. Observer consolidates → session.idle
  14. Plugin reads summary → PHASE 4

PHASE 4 — FINALIZATION
──────────────────────
  15. Plugin extracts consolidated summary
  16. Plugin injects into S1 via session.prompt({noReply: true})
  17. Plugin injects delimiter noReply in S2:
      "━━━ Roundtable Concluded ━━━
       Messages below this line are not part of the original debate.
       The result was consolidated in the main session."
  18. Plugin updates S2 title: "Roundtable: A vs B · CONCLUDED"
  19. Plugin shows toast "Roundtable concluded"
  20. Plugin clears in-memory state for S2
```

### Flow (mode: "extend")

```
  1. Orchestrator calls roundtable({mode:"extend", sessionID, rounds, prompt})
  2. Plugin fetches serialized state from S2 (from the noReply tag)
  3. Plugin restores history + config of the original roundtable
  4. Adds new rounds to totalRounds (accumulative)
  5. Sends continuation prompt to agents[0]
  6. Returns to PHASE 2 of the normal flow
```

---

## 5. States

### Roundtable state machine

```
         ┌────────────┐
         │  PENDING   │  (initial state, before S2 creation)
         └─────┬──────┘
               │ session.create() + prompt[0]
               ▼
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
         │ session.deleted
         ▼
     ┌────────────┐
     │  ABORTED   │
     └────────────┘
```

> **Note**: unlike the previous spec, `OBSERVING` **always** runs.
> The built-in default observer guarantees every debate produces a
> consolidated summary at the end.

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
  phase: "active" | "observing" | "done" | "aborted"

  // Data
  history: HistoryEntry[]
  errors: string[]
  createdAt: number
}

interface HistoryEntry {
  agent: string
  round: number
  response: string           // plain text of the response
  toolCalls: ToolCallSummary[]   // tool names + output previews
  hasError: boolean
}

interface ToolCallSummary {
  toolName: string
  outputPreview: string      // first 500 chars of output, or "error"
}
```

### Serialization in S2

State is serialized into a `noReply` message at the start of S2 to survive
restarts and enable the `extend` mode:

```
[ROUNDTABLE META]
{"sessionID":"S2","agents":["pm","dev"],"totalRounds":2,
 "observer":"built-in","prompt":"...","currentRound":1,
 "currentAgentIndex":0,"phase":"active","history":[...]}
[/ROUNDTABLE META]
```

---

## 6. History & Context

### Content sent to each agent

Each time the plugin passes the turn, it sends a message with:

```
╔══ ROUNDTABLE ════════════════════════════════╗
║ Topic: {prompt}                              ║
║ Your role: {agentName}                       ║
║ Round: {round}/{totalRounds}                 ║
║ Participants: {agents}                       ║
╚══════════════════════════════════════════════╝

Discussion so far:
━━━  {agent1}  ·  Round {r}  ━━━
{response_text_1}
{Tools used: ls src/ → (src/app.ts, src/utils/...)}

━━━  {agent2}  ·  Round {r}  ━━━
{response_text_2}
{Tools used: read src/app.ts → (file contents)}
...

Your turn, {agentName}. {role-specific instructions}.

{last round + last agent: "This is the final speech. At the end,
 provide a summary of your position."}
```

### What the plugin includes in history

The accumulated history contains **everything relevant for the next debater**:

- `TextPart.text` — agent's textual response
- `ToolCallSummary` — tool name + **output preview** (first 500 characters).
  If DEV ran `ls src/`, the next agent sees the discovered directory structure.
- `FilePart` — file references (name only, not full content)

### What the plugin does NOT include in history

- `ReasoningPart.text` — agent's internal reasoning (stays in S2 session, but
  not injected into the next agent's prompt text; the next agent can browse
  S2 to see it)
- `StepStartPart` / `StepFinishPart` — execution metadata

### Why include tool outputs in the prompt text?

Debaters need to see **what was discovered**, not just what was said.
If DEV ran `ls src/` and found the project structure, PM should see that
finding to base their argument on it. This is why tool outputs enter the
textual summary the plugin builds (500-char preview).

What the plugin controls is the format: outputs are included as part of each
agent's discussion block, not as standalone tool calls.

---

## 7. Edge Case Handling

### 7.1 Agent failure (provider error)

```
session.error on S2 with agent = currentAgent
  → Logs error in state.errors[]
  → Skips to next agent
  → Toast: "DEV failed on Round 2. Skipping to RV."
  → If all agents fail → aborts with error
```

### 7.2 User closes S2 (session.deleted)

```
session.deleted on S2
  → phase = "aborted"
  → state.history still has partial responses
  → Injects into S1:
    "[Roundtable interrupted — session closed.
     Partial history up to interruption:]
     {partial history}"
  → Toast: "Roundtable interrupted"
  → Clears state
```

### 7.3 User closes S1 (session.deleted on S1)

```
session.deleted on S1 === state.parentSessionID
  → Aborts S2 via session.abort({path:{id:S2}})
  → Clears state
```

### 7.4 User types a message in S2 during the debate

S2 is a visible and interactive session. If the user switches to S2
and types something:

- The message enters S2's context
- If the current agent is still processing, the user's message
  will be processed after the agent finishes
- The plugin continues the round-robin — the user's message becomes
  part of the history
- The plugin cannot detect "who" sent the message (there is no
  `trigger` field in the API)

**Behavior**: natural and desired. The user can intervene in the debate.

### 7.5 Debate loop (agents repeating arguments)

After each round, the plugin checks similarity between the latest response
and previous ones using **Jaccard similarity of bigrams (character pairs)**:

```
tokens1 = set(bigrams(current_text))
tokens2 = set(bigrams(previous_text))
similarity = |tokens1 ∩ tokens2| / |tokens1 ∪ tokens2|

if similarity > 0.85 (LOOP_SIMILARITY_THRESHOLD):
  → "Roundtable ended due to repetition — agents reached an impasse"
  → Injects partial result into S1
```

**Why Jaccard bigrams?**
- Purely computational (no LLM calls or embeddings needed)
- Zero external dependencies
- Reasonable for detecting textual argument repetition
- Threshold 0.85 is conservative — adjustable via constant

**Considerations**: the algorithm operates on cleaned text (without template
formatting). Comparison is between the last response of the current round
and the last response of the previous round, not all combinations.

### 7.6 Agent timeout

- Each agent turn has an implicit **5-minute** timeout
- Implemented via AbortController + setTimeout
- If it expires: `session.abort({path:{id:S2}})` → skip to next agent

### 7.7 Multiple simultaneous roundtables

Each roundtable has its own state in `Map<sessionID, RoundtableState>`.
They are independent. The plugin allows multiple roundtables running in
parallel.

### 7.8 Volatile state (OpenCode restart)

If OpenCode restarts mid-roundtable:
- In-memory state is lost
- S2 session remains in the database
- `noReply` messages with serialized state persist in S2

**Recovery**: on initialization, the plugin runs `scanOrphanRoundtables()`:
```
1. List all sessions via session.list()
2. For each session, search for messages tagged [ROUNDTABLE META]
3. If found:
   a) Check if parent S1 still exists
   b) If S1 exists → notify: "Roundtable #abc123 was interrupted by
      restart. Use mode:'extend' to continue."
   c) If S1 does not exist → abort S2 and clean up
```

### 7.9 Compaction during a roundtable

- The plugin does NOT trigger compaction automatically
- If the user or system compacts S2, `noReply` messages with serialized
  state survive (they are user messages in the session)
- The plugin uses `experimental.session.compacting` to re-inject critical
  state into the compaction prompt

### 7.10 Human message in S2 after conclusion

After `phase = "done"` (roundtable concluded):
- The plugin has already injected the `━━━ Roundtable Concluded ━━━`
  delimiter in S2
- The plugin stops listening to S2 events
- If the user types in S2, OpenCode responds normally with the session's
  default agent — **the plugin no longer interferes**
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
session's default model/provider. The plugin extracts the textual response
as the final summary.

### Explicit observer (override)

If the orchestrator passes `observer: "rv"`, the plugin:
1. Builds a similar prompt, but with `Your role: rv. Provide an executive summary...`
2. Sends via `session.prompt({ agent: "rv" })` on the S2 session
3. The "rv" agent responds with its own tools and personality

### Flow

```
1. All rounds complete → PHASE 3
2. Plugin decides:
   a) Explicit observer? → sends to that agent
   b) Default observer? → sends DEFAULT_OBSERVER_PROMPT to S2
3. Observer responds → session.idle
4. Plugin extracts text → injects into S1 as final result
5. Plugin injects delimiter noReply into S2
```

---

## 9. Extend Mode

### Usage

```typescript
roundtable({
  mode: "extend",
  sessionID: "abc123",         // Original S2 ID
  rounds: 2,
  prompt: "Dive deeper into operational costs",  // new prompt
})
```

### Prompt semantics in extend mode

The `prompt` parameter in `extend` mode can be:

| Intent | Example | Effect |
|--------|---------|--------|
| **Continuation** | "Debate more about X" | New prompt is sent as a complement to the original topic. `final_prompt = "Original topic: {original.prompt}\n\nContinuation: {prompt}"` |
| **New topic** | "Now plan Y" | New prompt replaces the topic, but previous history is preserved as context. `final_prompt = "Previous discussion history:\n{history}\n\nNew challenge: {prompt}"` |

The plugin infers intent heuristically: if the prompt starts with
"Debate more", "Continue", "Dive deeper" → continuation. Otherwise
→ new topic. The behavior can be refined during implementation.

### Flow

```
1. Plugin fetches S2 by sessionID
2. Reads S2 → session.messages(S2)
3. Finds [ROUNDTABLE META] tag → deserializes state
4. If phase !== "done" → error "Roundtable is still active"
5. Creates NEW state with:
   - agents, observer, prompt from ORIGINAL
   - rounds += new_rounds (accumulative)
   - history = restored previous history
   - extended_prompt = inferred intent (continuation or new topic)
6. Sets phase = "active"
7. Sends extended_prompt to agents[0]
8. Continues normal PHASE 2 flow
```

### Constraints

- Only works if S2 still exists (was not deleted)
- Only works if original phase was "done"
- Agents and observer must be the same as the original roundtable
- Previous discussion history is always preserved
- If the original roundtable used an explicit observer, the extend also uses
  it (observer type is stored in serialized state)

---

## 10. Visual Interface

### In the OpenCode TUI

| Element | How it works |
|---------|--------------|
| Agent colors | Native OpenCode via `agent.color` in config |
| Navigation | S2 is a child of S1 → `<Leader>+Right/Left` to switch |
| Toast | Plugin shows toast on start, completion, and errors |
| S2 title | Default: `"Roundtable: {agents.join(' vs ')} · {rounds} round(s)"`. Updates during debate: `"Roundtable: PM vs DEV (R2/3)"`. On conclusion: `"Roundtable: PM vs DEV · CONCLUDED"` |
| Message names | Each response is tagged with the speaking agent's name |

### TUI appearance example

```
┌─────────────────────────────────────────────────┐
│  Main Session (S1)                               │
├─────────────────────────────────────────────────┤
│  You: roundtable({agents:[pm,dev], rounds:2})   │
│                                                  │
│  Build: Roundtable started in child session      │
│         #abc123                                   │
│                                                  │
│  [noReply] ── Roundtable Concluded ──            │
│  Topic: What architecture?                        │
│  PM: microservices...                             │
│  DEV: monolith...                                 │
│  Conclusion: modular monolith                     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Roundtable Session #abc123 (child)              │
├─────────────────────────────────────────────────┤
│  [noReply] Debate rules...                        │
│  ── PM ──                                        │
│  The microservices approach allows...             │
│  ── DEV ──                                       │
│  Disagree, the complexity is not justified...    │
│  ── PM (R2) ──                                   │
│  OK, but what if we split only the...            │
│  ── DEV (R2) ──                                  │
│  That's basically a modular monolith...          │
│  [noReply] ━━━ Roundtable Concluded ━━━          │
└─────────────────────────────────────────────────┘
```

### Recommended color config

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

---

## 11. Plugin Structure

### Files

```
~/.config/opencode/plugins/
  └── roundtable.ts          # Main plugin file
```

### Dependencies

None external. Only `@opencode-ai/plugin` (peer dependency of OpenCode).

### Code structure

```typescript
// roundtable.ts
import { type Plugin, tool } from "@opencode-ai/plugin"

// == Types ==
interface RoundtableState { ... }
interface HistoryEntry { ... }
interface ToolCallSummary { ... }
type Phase = "active" | "observing" | "done" | "aborted"

// == Constants ==
const AGENT_TIMEOUT_MS = 300_000          // 5 min
const LOOP_SIMILARITY_THRESHOLD = 0.85    // Jaccard bigrams
const TOOL_OUTPUT_PREVIEW_MAX = 500       // tool output preview chars
const DEFAULT_OBSERVER_PROMPT = `You are an impartial roundtable observer...`

// == Plugin ==
export const RoundtablePlugin: Plugin = async (ctx) => {
  const states = new Map<string, RoundtableState>()

  // Init: scan for orphan roundtables (see 7.8)
  scanOrphanRoundtables(ctx, states)

  return {
    event: async ({ event }) => {
      if (!event.properties?.sessionID) return
      // session.idle → processNextTurn()
      // session.error → handleAgentError()
      // session.deleted → handleSessionDeleted()
    },

    "experimental.session.compacting": async (input, output) => {
      // Re-inject critical state during compaction
    },

    tool: {
      roundtable: tool({
        description: "Starts a multi-agent roundtable debate. Agents take turns discussing a topic.",
        args: {
          agents: tool.schema.array(tool.schema.string()).min(2),
          prompt: tool.schema.string(),
          rounds: tool.schema.number().min(1).default(1),
          observer: tool.schema.string().optional(),
          mode: tool.schema.enum(["new", "extend"]).default("new"),
          sessionID: tool.schema.string().optional(),
          title: tool.schema.string().optional(),
        },
        async execute(args, toolCtx) {
          switch (args.mode) {
            case "new": return startNewRoundtable(ctx, args, toolCtx, states)
            case "extend": return extendRoundtable(ctx, args, toolCtx, states)
          }
        },
      }),

      available_agents: tool({
        description: "Lists all configured agents that can participate in a roundtable.",
        args: {},
        async execute(_args, toolCtx) {
          const agents = await ctx.client.app.agents()
          return `Available agents: ${agents.map(a => a.name).join(", ")}`
        },
      }),
    },
  }
}

// == Validation ==
async function validateAgents(ctx, agentNames: string[]): Promise<ValidationResult> {
  // 1. Calls ctx.client.app.agents() → gets real agent list
  // 2. Checks each name in agentNames
  // 3. Checks for duplicates
  // 4. Checks min 2 agents
  // 5. Returns { valid, available, errors }
}

// == Helper functions ==
async function startNewRoundtable(...) { ... }
async function extendRoundtable(...) { ... }
async function processNextTurn(...) { ... }
async function sendToAgent(...) { ... }
async function finalizeRoundtable(...) { ... }
async function handleAgentError(...) { ... }
async function handleSessionDeleted(...) { ... }
function buildAgentPrompt(...): string { ... }
function buildObserverPrompt(...): string { ... }
function extractResponse(...): string | null { ... }
function detectLoop(...): boolean { ... }         // Jaccard bigrams
function buildToolSummary(...): ToolCallSummary { ... }
function injectRoundtableDelimiter(...) { ... }
function scanOrphanRoundtables(...) { ... }
function generateDefaultTitle(...): string { ... }
function serializeState(...): string { ... }
function deserializeState(...): RoundtableState { ... }
```

### Hooks used

| Hook | Purpose |
|------|---------|
| `event` | Listens to `session.idle`, `session.error`, `session.deleted` |
| `experimental.session.compacting` | Preserves state during compaction |
| `tool` | Defines the `roundtable` and `available_agents` tools |

### SDK APIs used

| API | Usage |
|-----|-------|
| `ctx.client.session.create()` | Create S2 |
| `ctx.client.session.prompt()` | Send messages to agents |
| `ctx.client.session.messages()` | Read agent responses |
| `ctx.client.session.abort()` | Abort timed-out agent |
| `ctx.client.session.update()` | Update session title |
| `ctx.client.tui.showToast()` | Notify user |
| `ctx.client.app.agents()` | Discover available agents |

---

## 12. Tests & Validation

### Test scenarios

1. **Basic roundtable**: 2 agents, 1 round, default observer
2. **Explicit observer**: 3 agents, 2 rounds, observer="rv" consolidates
3. **Default observer**: same scenario, no observer param → uses built-in
4. **Agent failure**: provider error → skip → continue
5. **Timeout**: agent takes too long → abort + skip
6. **Loop detection**: agents repeat arguments → Jaccard > 0.85 → end debate
7. **Session deleted**: close S2 → partial result in S1
8. **Extend (continuation)**: conclude → extend with "Debate more about X"
9. **Extend (new topic)**: conclude → extend with "Now plan Y"
10. **Multiple**: 2 roundtables in parallel
11. **Compaction**: compact S2 during debate → state preserved
12. **User interjection**: user writes in S2 during debate → continues
13. **Post-conclusion**: user writes in S2 after done → S2 becomes normal session
14. **Startup recovery**: restart during ACTIVE → scanOrphanRoundtables detects
15. **Invalid agent**: agents with nonexistent name → error with available list
16. **Available agents tool**: orchestrator calls `available_agents()` → gets list

### Acceptance criteria

- [ ] `roundtable` tool appears in the agent's tool list
- [ ] `available_agents` tool appears in the agent's tool list
- [ ] S2 is created as a child of S1
- [ ] Agents speak in the specified order
- [ ] Each agent keeps its own personality
- [ ] History + tool outputs are sent to each turn
- [ ] Default observer (built-in) consolidates the debate at the end
- [ ] Explicit observer (named agent) also works
- [ ] Final result is injected into S1
- [ ] Toast notifications appear on start, error, and conclusion
- [ ] Agent errors are skipped with notification
- [ ] Extend mode resumes from where it stopped (continuation and new topic)
- [ ] Session deletion is handled gracefully
- [ ] Loop detection works (Jaccard bigrams, threshold 0.85)
- [ ] Invalid agent names return an error with the available list
- [ ] `━━━ Roundtable Concluded ━━━` delimiter appears in S2 at the end
- [ ] Post-conclusion messages in S2 do not affect the S1 result
- [ ] Startup recovery detects and notifies about orphan roundtables

---

## 13. Glossary

| Term | Definition |
|------|------------|
| **S1** | Main session, where the user interacts |
| **S2** | Child session, where the roundtable runs |
| **Round** | One round = all agents speak once |
| **Turn** | A specific agent's turn to speak |
| **Observer** | Agent that does not debate, only summarizes |
| **Orchestrator** | Agent that called `roundtable()` |
| **History** | Accumulated discussion text |
| **Phase** | Current roundtable state |
| **Extend** | Continue a concluded roundtable |
| **noReply** | Injected message that does not trigger an AI response |
| **ToolCallSummary** | Record of a tool used by an agent: name + output preview (500 chars) |
| **Jaccard (bigrams)** | Text similarity algorithm used in loop detection: `|A∩B|/|A∪B|` over character pairs |
| **Default observer** | Built-in plugin mechanism that consolidates the debate into an executive summary without relying on an external agent |

---

## 14. References

- [OpenCode Plugin SDK](https://opencode.ai/docs/sdk/)
- [OpenCode Plugin API](https://opencode.ai/docs/plugins/)
- [OpenCode Agent Config](https://opencode.ai/docs/agents/)
- [OpenCode SDK Types (GitHub)](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js/src)
- `opencode-sessions` (reference plugin):
  `~/.cache/opencode/packages/opencode-sessions/node_modules/opencode-sessions/dist/index.js`
- `@opencode-ai/sdk` types:
  `~/.cache/opencode/packages/opencode-sessions/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
