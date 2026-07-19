# Implementation Plan

Six phases building from minimal scaffold to full plugin. Each phase produces
a working checkpoint that can be tested before moving on.

---

## Phase 1 — Plugin Scaffold

**Goal**: Plugin loads, `roundtable` tool appears, `available_agents` tool works.

### Tasks

- [ ] Create `roundtable.ts` in plugin structure
- [ ] Export `RoundtablePlugin` with empty event handler
- [ ] Define `RoundtableState`, `HistoryEntry`, `ToolCallSummary`, `Phase` types
- [ ] Define constants: `AGENT_TIMEOUT_MS`, `LOOP_SIMILARITY_THRESHOLD`, `TOOL_OUTPUT_PREVIEW_MAX`, `DEFAULT_OBSERVER_PROMPT`
- [ ] Implement `available_agents` tool (calls `ctx.client.app.agents()`)
- [ ] Implement `roundtable` tool shell (validates args, returns placeholder)
- [ ] Implement `validateAgents()` — fetches real agents, checks names
- [ ] Add `scanOrphanRoundtables()` init call (logs only, no action yet)
- [ ] **Test**: `/agents` available in tool list
- [ ] **Test**: `available_agents()` returns agent names
- [ ] **Test**: `roundtable()` with invalid agent returns error list

---

## Phase 2 — Session & Lifecycle

**Goal**: S2 is created, debate starts, round-robin sequencing works.

### Tasks

- [ ] Implement `startNewRoundtable()`:
  - [ ] Validate agents via `validateAgents()`
  - [ ] Call `ctx.client.session.create({ parentID: S1 })` → S2
  - [ ] Serialize initial state as `noReply` in S2
  - [ ] Call `generateDefaultTitle()` → set S2 title
  - [ ] Send first prompt to `agents[0]` via `session.prompt({ agent })`
  - [ ] Return confirmation string with S2 ID
- [ ] Implement `event` handler:
  - [ ] Filter events by `sessionID` matching known states
  - [ ] `session.idle` on S2 → `processNextTurn()`
  - [ ] `session.error` → `handleAgentError()`
  - [ ] `session.deleted` → `handleSessionDeleted()`
- [ ] Implement `processNextTurn()`:
  - [ ] Read S2 messages via `session.messages(S2)`
  - [ ] Extract response via `extractResponse()`
  - [ ] Build `ToolCallSummary[]` via `buildToolSummary()`
  - [ ] Append to `history[]`
  - [ ] Check `detectLoop()` → if loop detected, finalize early
  - [ ] Determine next agent or next phase
  - [ ] If next agent: `sendToAgent()`
  - [ ] If all rounds done: transition to `OBSERVING`
- [ ] Implement `sendToAgent()`:
  - [ ] Build prompt via `buildAgentPrompt()`
  - [ ] Call `session.prompt({ agent: nextAgent })`
  - [ ] Set timeout via `AbortController`
  - [ ] Update S2 title with current round info
- [ ] Implement `buildAgentPrompt()` with template from Sec 6
- [ ] **Test**: S2 created as child of S1
- [ ] **Test**: agents speak in order
- [ ] **Test**: each agent sees previous history
- [ ] **Test**: `detectLoop()` fires on repetition

---

## Phase 3 — Observer & Finalization

**Goal**: Observer consolidates debate, result injected in S1, S2 delimited.

### Tasks

- [ ] Implement `finalizeRoundtable()`:
  - [ ] Get consolidated summary from observer phase
  - [ ] Inject `noReply` in S1 with result
  - [ ] Call `injectRoundtableDelimiter()` in S2
  - [ ] Update S2 title to "CONCLUDED"
  - [ ] Show toast "Roundtable concluded"
  - [ ] Clear in-memory state
- [ ] Implement observer flow:
  - [ ] If explicit observer: `buildObserverPrompt()` with agent name, `session.prompt({ agent })`
  - [ ] If default: send `DEFAULT_OBSERVER_PROMPT` + history to S2 (no specific agent)
  - [ ] Wait for `session.idle`, extract response
- [ ] Implement `injectRoundtableDelimiter()`:
  - [ ] `session.prompt({ noReply: true })` with delimiter text
- [ ] Implement `buildObserverPrompt()`
- [ ] Implement `extractResponse()`:
  - [ ] Parse S2 messages for the latest assistant text
  - [ ] Handle empty/failed responses
- [ ] **Test**: observer summary appears in S1
- [ ] **Test**: delimiter appears in S2
- [ ] **Test**: toast fires on completion
- [ ] **Test**: explicit observer override works

---

## Phase 4 — Error Handling & Recovery

**Goal**: All edge cases from Sec 7 are handled gracefully.

### Tasks

- [ ] Implement `handleAgentError()`:
  - [ ] Log error in `state.errors[]`
  - [ ] Show toast with skip notification
  - [ ] Advance to next agent
  - [ ] If all agents failed → abort with error message
- [ ] Implement timeout in `sendToAgent()`:
  - [ ] `AbortController` with `AGENT_TIMEOUT_MS`
  - [ ] On timeout: `session.abort()`, skip to next agent, log
- [ ] Implement `handleSessionDeleted()`:
  - [ ] If S2 deleted: inject partial history into S1, toast
  - [ ] If S1 deleted: abort S2, clean up
- [ ] Implement `scanOrphanRoundtables()` in full:
  - [ ] List sessions, find `[ROUNDTABLE META]` tags
  - [ ] Check parent existence
  - [ ] Notify or clean up
- [ ] Add compaction hook:
  - [ ] Re-inject `[ROUNDTABLE META]` state into compaction context
- [ ] **Test**: agent failure skips gracefully
- [ ] **Test**: timeout aborts and skips
- [ ] **Test**: S2 deletion returns partial result to S1
- [ ] **Test**: S1 deletion aborts S2
- [ ] **Test**: compaction preserves state
- [ ] **Test**: restart recovery detects orphan

---

## Phase 5 — Extend Mode

**Goal**: `mode: "extend"` resumes a concluded roundtable.

### Tasks

- [ ] Implement `extendRoundtable()`:
  - [ ] Fetch S2 by `sessionID`
  - [ ] Parse `[ROUNDTABLE META]` via `deserializeState()`
  - [ ] Validate phase was `"done"`
  - [ ] Create new state with preserved config + accumulated rounds
  - [ ] Create extended prompt (continuation or new topic heuristic)
  - [ ] Send to `agents[0]`, continue normal flow
- [ ] Implement `serializeState()`:
  - [ ] JSON.stringify state, wrap in `[ROUNDTABLE META]` tags
- [ ] Implement `deserializeState()`:
  - [ ] Parse `[ROUNDTABLE META]` from messages
  - [ ] JSON.parse, validate fields
- [ ] **Test**: extend with continuation prompt
- [ ] **Test**: extend with new topic prompt
- [ ] **Test**: extend on non-existent S2 returns error
- [ ] **Test**: extend on active roundtable returns error

---

## Phase 6 — Polish & Tests

**Goal**: Production-ready plugin with full test coverage.

### Tasks

- [ ] Add `generateDefaultTitle()`:
  - [ ] Format: `"Roundtable: {agents} · {rounds} round(s)"`
  - [ ] Update dynamically during debate
  - [ ] Append " · CONCLUDED" on completion
- [ ] Implement `detectLoop()` with Jaccard bigrams:
  - [ ] Tokenize into character bigrams
  - [ ] Compute `|intersection| / |union|`
  - [ ] Compare against `LOOP_SIMILARITY_THRESHOLD`
- [ ] Implement `buildToolSummary()`:
  - [ ] Parse S2 messages for tool call parts
  - [ ] Extract name + first `TOOL_OUTPUT_PREVIEW_MAX` chars
- [ ] Ensure user messages in S2 (Sec 7.4) do not break state machine
- [ ] Ensure post-conclusion S2 messages (Sec 7.10) are ignored by plugin
- [ ] Run all 16 test scenarios from Sec 12
- [ ] Add inline comments to clarify event-driven flow
- [ ] Verify with `@opencode-ai/plugin` types
- [ ] **Final**: Full acceptance criteria from Sec 12 pass

---

## Phase Dependencies

```
Phase 1 ─── Phase 2 ─── Phase 3 ─── Phase 5
                │                       │
                └── Phase 4 ────────────┘
                              │
                              └── Phase 6
```

- Phase 2 depends on Phase 1
- Phase 3 depends on Phase 2
- Phase 4 depends on Phase 2 (debate running)
- Phase 5 depends on Phase 3 (serialization) + Phase 4 (recovery)
- Phase 6 depends on all previous phases
