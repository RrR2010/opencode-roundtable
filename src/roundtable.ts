/**
 * Roundtable Plugin for OpenCode
 *
 * Orchestrates multi-agent round-robin debates with isolated sessions,
 * shared context between debaters, a built-in observer (with override),
 * and extension support.
 *
 * @see docs/SPEC.md   — Full technical specification
 * @see docs/IMPLEMENTATION.md — Phased implementation plan
 */

import { type Plugin, type PluginInput, type ToolContext, tool } from "@opencode-ai/plugin"
import type { Event, Part } from "@opencode-ai/sdk"

// ============================================================
// Types
// ============================================================

interface RoundtableState {
  /** S2 session ID */
  sessionID: string
  /** S1 (parent) session ID */
  parentSessionID: string

  /** Agent names in speaking order */
  agents: string[]
  /** Total number of complete rounds */
  totalRounds: number
  /** "built-in" = plugin default, otherwise an agent name */
  observer: "built-in" | string
  /** Original debate prompt */
  prompt: string

  /** 0-indexed current round */
  currentRound: number
  /** 0-indexed current agent index within the round */
  currentAgentIndex: number
  /** Current lifecycle phase */
  phase: Phase

  /** Accumulated discussion history */
  history: HistoryEntry[]
  /** Error messages accumulated during the debate */
  errors: string[]
  /** Timestamp when the roundtable was created */
  createdAt: number
}

interface HistoryEntry {
  agent: string
  round: number
  response: string
  toolCalls: ToolCallSummary[]
  hasError: boolean
}

interface ToolCallSummary {
  toolName: string
  /** First N characters of tool output, or "error" */
  outputPreview: string
}

/** Lifecycle phase of a roundtable session */
type Phase = "active" | "observing" | "done" | "aborted"

/** Inferred argument shape for the `roundtable` tool */
interface RoundtableArgs {
  agents: string[]
  prompt: string
  rounds: number
  observer?: string
  mode: "new" | "extend"
  sessionID?: string
  title?: string
}

interface ValidationResult {
  valid: boolean
  available: { name: string; description?: string }[]
  errors: string[]
}

// ============================================================
// Constants
// ============================================================

/** Per-agent timeout in milliseconds (5 minutes) */
const AGENT_TIMEOUT_MS = 300_000

/** Jaccard bigram similarity threshold for loop detection */
const LOOP_SIMILARITY_THRESHOLD = 0.85

/** Maximum characters of tool output to include in preview */
const TOOL_OUTPUT_PREVIEW_MAX = 500

/** Default built-in observer prompt */
const DEFAULT_OBSERVER_PROMPT = `You are an impartial roundtable observer.
Consolidate the debate below into:

1. **Executive summary** (2-3 sentences)
2. **Key points** raised by each participant
3. **Decisions or convergences** reached
4. **Remaining open questions**
5. **Suggested next steps`

// ============================================================
// Module-level state stores
// ============================================================

/** Map<S2 session ID → RoundtableState> */
const states = new Map<string, RoundtableState>()

/** Map<S2 session ID → setTimeout handle> for agent timeout management */
const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>()

// ============================================================
// Plugin
// ============================================================

export const RoundtablePlugin: Plugin = async (ctx) => {
  // Phase 1: log-only initialization
  await scanOrphanRoundtables(ctx)

  return {
    event: async ({ event }) => {
      const sessionID = getSessionIdFromEvent(event)
      if (!sessionID || !states.has(sessionID)) return

      const state = states.get(sessionID)!

      switch (event.type) {
        case "session.idle": {
          // Clear any pending agent timeout
          const handle = timeoutHandles.get(sessionID)
          if (handle) {
            clearTimeout(handle)
            timeoutHandles.delete(sessionID)
          }
          // Process the turn regardless of phase
          await processNextTurn(ctx, state)
          break
        }
        case "session.error": {
          await handleAgentError(ctx, state, event)
          break
        }
        case "session.deleted": {
          // session.deleted carries the session in info.id
          const deletedID = event.properties.info.id
          await handleSessionDeleted(ctx, state, deletedID)
          break
        }
      }
    },

    "experimental.session.compacting": async (
      _input: { sessionID: string },
      _output: { context: string[]; prompt?: string },
    ) => {
      // Phase 4: will re-inject [ROUNDTABLE META] state during compaction
      // to preserve the roundtable across token-limit compression.
    },

    tool: {
      roundtable: tool({
        description:
          "Starts a multi-agent roundtable debate. " +
          "Agents take turns discussing a topic, each seeing the full discussion history.",

        args: {
          agents: tool.schema
            .array(tool.schema.string())
            .min(2)
            .describe("Agent names in speaking order (min 2)"),
          prompt: tool.schema.string().describe("Topic or challenge to debate"),
          rounds: tool.schema
            .number()
            .min(1)
            .default(1)
            .describe("Number of complete rounds"),
          observer: tool.schema
            .string()
            .optional()
            .describe("Agent name for final consolidation (default: built-in observer)"),
          mode: tool.schema
            .enum(["new", "extend"])
            .default("new")
            .describe("'new' creates a fresh debate; 'extend' continues a concluded one"),
          sessionID: tool.schema
            .string()
            .optional()
            .describe("S2 session ID to extend (required when mode is 'extend')"),
          title: tool.schema
            .string()
            .optional()
            .describe("Custom title for the child session"),
        },

        async execute(args, toolCtx) {
          // Validate agents first
          const validation = await validateAgents(ctx, args.agents)
          if (!validation.valid) {
            const available = validation.available.map((a) => a.name).join(", ")
            return [
              "Invalid agent configuration:",
              ...validation.errors.map((e) => `  - ${e}`),
              `Available agents: ${available}`,
            ].join("\n")
          }

          switch (args.mode) {
            case "new":
              return startNewRoundtable(ctx, args as RoundtableArgs, toolCtx)
            case "extend": {
              if (!args.sessionID) {
                return "Error: sessionID is required when mode is 'extend'"
              }
              return extendRoundtable(ctx, args as RoundtableArgs, toolCtx)
            }
          }
        },
      }),

      available_agents: tool({
        description:
          "Lists all configured agents that can participate in a roundtable. " +
          "Use this to discover agent names before calling roundtable().",

        args: {},

        async execute() {
          const result = await ctx.client.app.agents()
          const names = result.data.map(
            (a: { name: string; description?: string }) => a.name,
          )
          return `Available agents: ${names.join(", ")}`
        },
      }),
    },
  } as unknown as ReturnType<Plugin>
}

// ============================================================
// Event Helpers
// ============================================================

/**
 * Extract a session ID from any event type we care about.
 *
 * Handles:
 * - Direct `properties.sessionID` (session.idle, session.error)
 * - Nested `properties.info.id` (session.deleted)
 */
function getSessionIdFromEvent(event: Event): string | undefined {
  if (!("properties" in event)) return undefined

  const props = event.properties as Record<string, unknown>

  // Direct sessionID property (most event types)
  if (typeof props.sessionID === "string") {
    return props.sessionID
  }

  // session.deleted and session.created carry the session in `info`
  if (props.info && typeof props.info === "object") {
    const info = props.info as { id?: string }
    if (info.id) return info.id
  }

  return undefined
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate agent names against the real agent registry.
 *
 * Checks:
 * 1. Minimum 2 agents provided
 * 2. No duplicate names
 * 3. Every name matches a configured agent
 */
async function validateAgents(
  ctx: PluginInput,
  agentNames: string[],
): Promise<ValidationResult> {
  const errors: string[] = []

  // --- Min 2 check ---
  if (agentNames.length < 2) {
    errors.push("At least 2 agents are required")
    return { valid: false, available: [], errors }
  }

  // --- Duplicates check ---
  const seen = new Set<string>()
  for (const name of agentNames) {
    if (seen.has(name)) {
      errors.push(`Duplicate agent: "${name}"`)
    }
    seen.add(name)
  }
  if (errors.length > 0) {
    return { valid: false, available: [], errors }
  }

  // --- Fetch real agents ---
  let available: { name: string; description?: string }[] = []
  try {
    const result = await ctx.client.app.agents()
    available = result.data.map((a: { name: string; description?: string }) => ({
      name: a.name,
      description: a.description,
    }))
  } catch {
    errors.push("Failed to fetch available agents from server")
    return { valid: false, available: [], errors }
  }

  // --- Name matching ---
  const availableNames = new Set(available.map((a) => a.name))
  for (const name of agentNames) {
    if (!availableNames.has(name)) {
      errors.push(`Agent "${name}" not found`)
    }
  }

  return {
    valid: errors.length === 0,
    available,
    errors,
  }
}

// ============================================================
// Core Roundtable Functions
// ============================================================

/**
 * Create a new roundtable session (S2) and start the debate.
 */
async function startNewRoundtable(
  ctx: PluginInput,
  args: RoundtableArgs,
  toolCtx: ToolContext,
): Promise<string> {
  // 1. Create S2 as a child of the calling session (S1)
  const newSession = await ctx.client.session.create({
    body: {
      parentID: toolCtx.sessionID,
      title: generateDefaultTitle(args),
    },
  })

  const sessionID = newSession.data.id
  const parentSessionID = toolCtx.sessionID

  // 2. Initialise in-memory state
  const state: RoundtableState = {
    sessionID,
    parentSessionID,
    agents: args.agents,
    totalRounds: args.rounds,
    observer: args.observer ?? "built-in",
    prompt: args.prompt,
    currentRound: 0,
    currentAgentIndex: 0,
    phase: "active",
    history: [],
    errors: [],
    createdAt: Date.now(),
  }
  states.set(sessionID, state)

  // 3. Serialise initial state as a noReply message in S2 (survives compaction)
  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text: serializeState(state) }],
    },
  })

  // 4. Send the first prompt to agents[0]
  await sendToAgent(ctx, state)

  // 5. Toast to the user
  await ctx.client.tui.showToast({
    body: {
      message: `Roundtable started in #${sessionID} (${args.agents.join(" → ")} · ${args.rounds} round(s))`,
      variant: "info",
    },
  })

  // 6. Return confirmation string
  const agentList = args.agents.join(" → ")
  return `Roundtable started in child session #${sessionID} (${agentList} · ${args.rounds} round(s))`
}

/**
 * Continue a concluded roundtable with additional rounds.
 *
 * Phase 5: fetches S2 by sessionID, deserializes state from [ROUNDTABLE META],
 * restores config + history, and starts new rounds.
 */
async function extendRoundtable(
  _ctx: PluginInput,
  args: RoundtableArgs,
  _toolCtx: ToolContext,
): Promise<string> {
  return [
    `[Phase 5] Extend mode validated. Session: ${args.sessionID}, rounds: ${args.rounds}.`,
    "Full extend flow with state deserialization will be implemented in Phase 5.",
  ].join("\n")
}

/**
 * Process the next turn in the round-robin sequence.
 * Called when `session.idle` fires on S2.
 *
 * Handles two phases:
 * - "active"    → extract last response, build history, decide next turn
 * - "observing" → extract observer summary, finalise the roundtable
 */
async function processNextTurn(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  // Guard: ignore idle events for sessions that are done or aborted
  if (state.phase === "done" || state.phase === "aborted") return

  // 1. Read S2 messages
  const result = await ctx.client.session.messages({
    path: { id: state.sessionID },
  })
  const messages = result.data

  // 2. Find the latest assistant message (the one that just finished)
  const assistantMsgs = messages.filter(
    (m: { info: { role: string } }) => m.info.role === "assistant",
  )
  if (assistantMsgs.length === 0) return // no assistant response yet

  const latestMsg = assistantMsgs[assistantMsgs.length - 1]

  // =================================================================
  // ACTIVE PHASE — process a debater's response
  // =================================================================
  if (state.phase === "active") {
    // 3. Extract response text
    const response = extractResponse(latestMsg.parts)
    if (!response) {
      // No text part found — treat as an error for this turn
      state.errors.push(
        `Agent ${state.agents[state.currentAgentIndex]} returned no text in round ${state.currentRound + 1}`,
      )
    }

    // 4. Build tool summaries from the message parts
    const toolCalls = buildToolSummaries(latestMsg.parts)

    // 5. Append to history
    const entry: HistoryEntry = {
      agent: state.agents[state.currentAgentIndex],
      round: state.currentRound,
      response: response ?? "(no text response)",
      toolCalls,
      hasError: response === null,
    }
    state.history.push(entry)

    // 6. Loop detection (compare last two responses)
    if (detectLoop(state.history)) {
      state.errors.push("Loop detected — agents reached an impasse")
      state.phase = "done"
      await finalizeRoundtable(ctx, state)
      return
    }

    // 7. Determine next step
    const nextIndex = state.currentAgentIndex + 1
    if (nextIndex < state.agents.length) {
      // ── Next agent in this round ──
      state.currentAgentIndex = nextIndex
      await sendToAgent(ctx, state)
    } else if (state.currentRound + 1 < state.totalRounds) {
      // ── Next round, back to first agent ──
      state.currentRound++
      state.currentAgentIndex = 0
      await sendToAgent(ctx, state)
    } else {
      // ── All rounds complete → transition to observer ──
      state.phase = "observing"
      await sendObserverPrompt(ctx, state)
    }
    return
  }

  // =================================================================
  // OBSERVING PHASE — extract the observer's summary and finalise
  // =================================================================
  if (state.phase === "observing") {
    const summary = extractResponse(latestMsg.parts)
    state.history.push({
      agent: "observer",
      round: state.currentRound,
      response: summary ?? "(no summary)",
      toolCalls: [],
      hasError: summary === null,
    })

    state.phase = "done"
    await finalizeRoundtable(ctx, state)
  }
}

/**
 * Send a prompt to the current agent in the roundtable session.
 *
 * Builds the agent prompt from history, sends it via session.prompt(),
 * starts the 5-minute timeout, and updates the S2 title.
 */
async function sendToAgent(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const agent = state.agents[state.currentAgentIndex]
  const prompt = buildAgentPrompt(state, agent)

  // 1. Send prompt to the agent
  await ctx.client.session.prompt({
    path: { id: state.sessionID },
    body: {
      agent,
      parts: [{ type: "text", text: prompt }],
    },
  })

  // 2. Set timeout: if the agent takes > AGENT_TIMEOUT_MS, abort the session
  const handle = setTimeout(async () => {
    try {
      await ctx.client.session.abort({
        path: { id: state.sessionID },
      })
      state.errors.push(
        `Agent "${agent}" timed out after ${AGENT_TIMEOUT_MS / 1000}s`,
      )
    } catch {
      // Session may already be done or aborted — ignore
    }
  }, AGENT_TIMEOUT_MS)

  timeoutHandles.set(state.sessionID, handle)

  // 3. Update S2 title to reflect current round
  await updateSessionTitle(ctx, state)
}

/**
 * Update the S2 session title with current round progress.
 */
async function updateSessionTitle(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const agentList = state.agents.join(" vs ")
  const roundInfo = `R${state.currentRound + 1}/${state.totalRounds}`
  const title = `Roundtable: ${agentList} (${roundInfo})`
  await ctx.client.session.update({
    path: { id: state.sessionID },
    body: { title },
  })
}

/**
 * Send the observer prompt after all debate rounds are complete.
 *
 * - Explicit observer (named agent) → sends to that agent with its personality
 * - Default built-in observer        → sends to S2 (no specific agent)
 */
async function sendObserverPrompt(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const prompt = buildObserverPrompt(state, state.observer)

  if (state.observer === "built-in") {
    // Default observer: send to the session itself (session default model)
    await ctx.client.session.prompt({
      path: { id: state.sessionID },
      body: {
        noReply: false,
        parts: [{ type: "text", text: prompt }],
      },
    })
  } else {
    // Explicit observer: send to the named agent
    await ctx.client.session.prompt({
      path: { id: state.sessionID },
      body: {
        agent: state.observer,
        parts: [{ type: "text", text: prompt }],
      },
    })
  }
}

/**
 * Finalize the roundtable: inject result into S1, delimit S2, clean up.
 *
 * Called after:
 * - Observer finishes (normal conclusion)
 * - Loop detection fires (early conclusion)
 */
async function finalizeRoundtable(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const sessionID = state.sessionID
  const parentSessionID = state.parentSessionID

  try {
    // 1. Build consolidated summary from history
    const summary = buildConsolidatedSummary(state)

    // 2. Inject final result into S1 as a noReply message
    await ctx.client.session.prompt({
      path: { id: parentSessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: summary }],
      },
    })

    // 3. Inject delimiter in S2
    await injectRoundtableDelimiter(ctx, sessionID)

    // 4. Update S2 title to CONCLUDED
    const agentList = state.agents.join(" vs ")
    await ctx.client.session.update({
      path: { id: sessionID },
      body: { title: `Roundtable: ${agentList} · CONCLUDED` },
    })

    // 5. Show toast
    await ctx.client.tui.showToast({
      body: {
        message: "Roundtable concluded",
        variant: "success",
      },
    })
  } catch (err) {
    // Log error but still clean up state
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "error",
          message: `Failed to finalize roundtable #${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
          extra: { sessionID, phase: state.phase },
        },
      })
    } catch {
      // Best-effort logging
    }
  } finally {
    // 6. Clear in-memory state
    states.delete(sessionID)
  }
}

/**
 * Build a plain-text consolidated summary from the roundtable history.
 */
function buildConsolidatedSummary(state: RoundtableState): string {
  const lines: string[] = []
  lines.push(`━━━ Roundtable Concluded ━━━`)
  lines.push(`Topic: ${state.prompt}`)
  lines.push(`Participants: ${state.agents.join(", ")}`)
  if (state.errors.length > 0) {
    lines.push(`Errors: ${state.errors.join("; ")}`)
  }
  lines.push("")

  for (const entry of state.history) {
    const label =
      entry.agent === "observer"
        ? "Observer"
        : `${entry.agent} (Round ${entry.round + 1})`
    lines.push(`── ${label} ──`)
    lines.push(entry.response)
    if (entry.toolCalls.length > 0) {
      const toolLines = entry.toolCalls.map(
        (tc) => `  • ${tc.toolName} → ${tc.outputPreview.slice(0, 80)}`,
      )
      lines.push(...toolLines)
    }
    if (entry.hasError) {
      lines.push("  ⚠ This response had errors")
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Handle an agent error (provider failure, timeout, etc.).
 *
 * Logs the error, shows a toast, and attempts to skip to the next agent.
 * If all agents fail, aborts the roundtable.
 */
async function handleAgentError(
  ctx: PluginInput,
  state: RoundtableState,
  event: Event,
): Promise<void> {
  const agent = state.agents[state.currentAgentIndex]
  const errorMsg =
    event.type === "session.error" && event.properties.error
      ? String(event.properties.error)
      : "Unknown error"

  state.errors.push(`Agent "${agent}" failed on round ${state.currentRound + 1}: ${errorMsg}`)

  // Clear any pending timeout for this session
  const handle = timeoutHandles.get(state.sessionID)
  if (handle) {
    clearTimeout(handle)
    timeoutHandles.delete(state.sessionID)
  }

  // Show toast
  await ctx.client.tui.showToast({
    body: {
      message: `"${agent}" failed on Round ${state.currentRound + 1}. Skipping to next.`,
      variant: "warning",
    },
  })

  // Determine if we should skip or abort
  const nextIndex = state.currentAgentIndex + 1
  if (nextIndex < state.agents.length) {
    // Skip to next agent in this round
    state.currentAgentIndex = nextIndex
    await sendToAgent(ctx, state)
  } else if (state.currentRound + 1 < state.totalRounds) {
    // Move to next round
    state.currentRound++
    state.currentAgentIndex = 0
    await sendToAgent(ctx, state)
  } else {
    // All agents failed — abort
    state.phase = "aborted"
    try {
      await ctx.client.tui.showToast({
        body: {
          message: "All agents failed — roundtable aborted",
          variant: "error",
        },
      })
    } catch {
      // Best-effort
    }
    states.delete(state.sessionID)
  }
}

/**
 * Handle session deletion.
 *
 * - If S2 (roundtable session) is deleted: inject partial history into S1, clean up.
 * - If S1 (parent session) is deleted: abort S2, clean up.
 */
async function handleSessionDeleted(
  ctx: PluginInput,
  state: RoundtableState,
  deletedSessionID: string,
): Promise<void> {
  if (deletedSessionID === state.sessionID) {
    // ── S2 was deleted → inject partial result into S1 ──
    state.phase = "aborted"

    const partialSummary = buildConsolidatedSummary(state)
    const lines = [
      "[Roundtable interrupted — session closed]",
      "Partial history up to interruption:",
      "",
      partialSummary,
    ]

    try {
      await ctx.client.session.prompt({
        path: { id: state.parentSessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: lines.join("\n") }],
        },
      })
      await ctx.client.tui.showToast({
        body: {
          message: "Roundtable interrupted",
          variant: "warning",
        },
      })
    } catch {
      // Parent session may also be gone
    }
  } else if (deletedSessionID === state.parentSessionID) {
    // ── S1 was deleted → abort S2 ──
    state.phase = "aborted"
    try {
      await ctx.client.session.abort({
        path: { id: state.sessionID },
      })
    } catch {
      // S2 may already be gone
    }
  }

  // Clean up state
  states.delete(state.sessionID)
}

/**
 * Build the structured prompt sent to each agent on their turn.
 *
 * Template from SPEC §6 — shows topic, role, round info, participants,
 * full discussion history with tool outputs, and turn-specific instructions.
 */
function buildAgentPrompt(
  state: RoundtableState,
  agent: string,
): string {
  const lines: string[] = []

  // ── Header ──
  lines.push("╔══ ROUNDTABLE ════════════════════════════════╗")
  lines.push(`║ Topic: ${state.prompt}`)
  lines.push(`║ Your role: ${agent}`)
  lines.push(`║ Round: ${state.currentRound + 1}/${state.totalRounds}`)
  lines.push(`║ Participants: ${state.agents.join(", ")}`)
  lines.push("╚══════════════════════════════════════════════╝")
  lines.push("")

  // ── Discussion history ──
  if (state.history.length === 0) {
    lines.push("The debate is just starting. No previous discussion yet.")
  } else {
    lines.push("Discussion so far:")
    for (const entry of state.history) {
      lines.push("")
      lines.push(`━━━  ${entry.agent}  ·  Round ${entry.round + 1}  ━━━`)
      lines.push(entry.response)

      // Append tool summaries inline
      if (entry.toolCalls.length > 0) {
        const toolParts = entry.toolCalls.map((tc) => {
          const preview =
            tc.outputPreview.length > 80
              ? tc.outputPreview.slice(0, 80) + "…"
              : tc.outputPreview
          return `${tc.toolName} → ${preview}`
        })
        lines.push(`Tools used: ${toolParts.join("; ")}`)
      }

      if (entry.hasError) {
        lines.push("(This response had errors)")
      }
    }
  }

  lines.push("")
  lines.push(`Your turn, ${agent}.`)

  // ── Final speech hint ──
  const isLastAgent =
    state.currentAgentIndex === state.agents.length - 1
  const isLastRound = state.currentRound === state.totalRounds - 1
  if (isLastAgent && isLastRound) {
    lines.push(
      "This is the final speech of the debate. At the end, provide a summary of your position.",
    )
  }

  return lines.join("\n")
}

/**
 * Build the observer prompt from the full debate history.
 *
 * - Explicit observer: role-specific instructions are added.
 * - Default (built-in): uses the DEFAULT_OBSERVER_PROMPT template.
 */
function buildObserverPrompt(
  state: RoundtableState,
  observer: "built-in" | string,
): string {
  const historyText = state.history
    .map(
      (entry) =>
        `── ${entry.agent} (Round ${entry.round + 1}) ──\n${entry.response}` +
        (entry.toolCalls.length > 0
          ? `\nTools: ${entry.toolCalls.map((t) => `${t.toolName} → ${t.outputPreview.slice(0, 100)}`).join("; ")}`
          : ""),
    )
    .join("\n\n")

  if (observer === "built-in") {
    return `${DEFAULT_OBSERVER_PROMPT}\n\nDebate:\n${historyText}`
  }

  return (
    `You are an impartial roundtable observer.\n` +
    `Your role: ${observer}. Provide an executive summary of the debate.\n\n` +
    `${DEFAULT_OBSERVER_PROMPT}\n\nDebate:\n${historyText}`
  )
}

/**
 * Extract the assistant response text from a message's parts array.
 * Returns the first `type: "text"` content, or null if none found.
 */
function extractResponse(parts: Part[]): string | null {
  for (const part of parts) {
    if (part.type === "text") {
      return part.text
    }
  }
  return null
}

/**
 * Detect debate loop using Jaccard similarity of character bigrams.
 *
 * Compares the last response against the previous one.
 * Returns true if similarity exceeds LOOP_SIMILARITY_THRESHOLD (0.85).
 *
 * Why Jaccard bigrams?
 * - Purely computational (no LLM calls or embeddings needed)
 * - Zero external dependencies
 * - Reasonable for detecting textual argument repetition
 */
function detectLoop(history: HistoryEntry[]): boolean {
  if (history.length < 2) return false

  const last = history[history.length - 1].response
  const prev = history[history.length - 2].response

  // Build character bigram sets
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    const cleaned = s.replace(/[\s\n\r]+/g, " ") // normalise whitespace
    for (let i = 0; i < cleaned.length - 1; i++) {
      set.add(cleaned.slice(i, i + 2))
    }
    return set
  }

  const lastBigrams = bigrams(last)
  const prevBigrams = bigrams(prev)

  // Intersection size
  let intersection = 0
  for (const b of lastBigrams) {
    if (prevBigrams.has(b)) intersection++
  }

  // Union size
  const union = new Set([...lastBigrams, ...prevBigrams])
  if (union.size === 0) return false // empty strings

  return intersection / union.size > LOOP_SIMILARITY_THRESHOLD
}

/**
 * Build a ToolCallSummary from a single Part.
 * Returns null if the part is not a tool part.
 */
function buildToolSummary(part: Part): ToolCallSummary | null {
  if (part.type !== "tool") return null

  const toolName = part.tool
  let outputPreview: string

  switch (part.state.status) {
    case "completed":
      outputPreview = part.state.output.slice(0, TOOL_OUTPUT_PREVIEW_MAX)
      break
    case "error":
      outputPreview = "error"
      break
    case "running":
    case "pending":
      outputPreview = `(${part.state.status})`
      break
    default:
      outputPreview = "(unknown)"
      break
  }

  return { toolName, outputPreview }
}

/**
 * Build an array of ToolCallSummary from a message's parts array.
 * Filters out non-tool parts.
 */
function buildToolSummaries(parts: Part[]): ToolCallSummary[] {
  const summaries: ToolCallSummary[] = []
  for (const part of parts) {
    const summary = buildToolSummary(part)
    if (summary) summaries.push(summary)
  }
  return summaries
}

/**
 * Inject the "━━━ Roundtable Concluded ━━━" delimiter into S2.
 *
 * Messages below this line are no longer part of the original debate.
 */
async function injectRoundtableDelimiter(
  ctx: PluginInput,
  sessionID: string,
): Promise<void> {
  const delimiter = [
    "━━━ Roundtable Concluded ━━━",
    "Messages below this line are not part of the original debate.",
    "The result was consolidated in the main session.",
  ].join("\n")

  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text: delimiter }],
    },
  })
}

/**
 * Scan orphan roundtables on plugin initialization.
 *
 * Phase 1: log only — no actual scanning yet.
 * Phase 4: list sessions, find [ROUNDTABLE META] tags, notify or clean up.
 */
async function scanOrphanRoundtables(
  ctx: PluginInput,
): Promise<void> {
  await ctx.client.app.log({
    body: {
      service: "roundtable",
      level: "info",
      message:
        "scanOrphanRoundtables initialized (Phase 1 — no scanning yet; " +
        "full implementation in Phase 4)",
      extra: { phase: 1 },
    },
  })
}

/**
 * Generate the default title for a roundtable child session.
 *
 * Format: "Roundtable: A vs B vs C · N round(s)"
 */
function generateDefaultTitle(args: RoundtableArgs): string {
  const agentList = args.agents.join(" vs ")
  const roundLabel = args.rounds === 1 ? "1 round" : `${args.rounds} rounds`
  return args.title ?? `Roundtable: ${agentList} · ${roundLabel}`
}

/**
 * Serialize roundtable state into a string tagged for persistence.
 *
 * The tagged format survives session compaction and enables the
 * `extend` mode (Phase 5). The state is stored as a noReply message
 * at the start of S2.
 *
 * Format:
 *   [ROUNDTABLE META]
 *   {JSON}
 *   [/ROUNDTABLE META]
 */
function serializeState(state: RoundtableState): string {
  const json = JSON.stringify(state, null, 2)
  return `[ROUNDTABLE META]\n${json}\n[/ROUNDTABLE META]`
}

/**
 * Deserialize roundtable state from a tagged string.
 * Returns null if parsing fails.
 */
function deserializeState(
  _raw: string,
): RoundtableState | null {
  // Phase 5: parse JSON between [ROUNDTABLE META] tags
  return null // stub
}
