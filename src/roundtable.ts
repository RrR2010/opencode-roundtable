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
import { readFile, writeFile } from "fs/promises"
import { join } from "path"
import os from "os"

// ============================================================
// Minimal local types for OpenCode SDK objects
// (Avoids import from @opencode-ai/sdk which may not resolve
//  in the plugin runtime context.)
// ============================================================

/** Shape of a session message Part */
interface Part {
  type: string
  text?: string
}

/** Shape of event objects received by the event hook */
interface Event {
  type: string
  properties: {
    sessionID?: string
    info?: { id?: string }
    error?: unknown
  }
}

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

  /** Message ID of the last processed assistant message (dedup guard) */
  lastProcessedMsgId?: string
  /** Monotonically increasing generation counter for race-condition protection */
  currentGeneration: number
  /** User interjection messages from S2 that appeared during the debate */
  userInterjections: string[]
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
type Phase = "active" | "observing" | "done" | "aborted" | "pending"

/** Configuration loaded from ~/.config/opencode/roundtable.json */
interface PluginConfig {
  defaultTimeoutMs: number
  loopSimilarityThreshold: number
  toolOutputPreviewMax: number
  defaultObserverPrompt: string
  maxRounds: number
}

/** Inferred argument shape for the `roundtable` tool */
interface RoundtableArgs {
  /** Agent names in speaking order. Required for mode:"new", stored from original for mode:"extend" */
  agents?: string[]
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
// Config path
// ============================================================

const configDir = (() => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) return join(xdgConfigHome, "opencode")
  return join(os.homedir(), ".config", "opencode")
})()

const configPath = join(configDir, "roundtable.json")

// ============================================================
// Default configuration (overridable via roundtable.json)
// ============================================================

const DEFAULT_CONFIG: PluginConfig = {
  defaultTimeoutMs: 300_000,
  loopSimilarityThreshold: 0.85,
  toolOutputPreviewMax: 500,
  defaultObserverPrompt: `You are an impartial roundtable observer.
Consolidate the debate below into:

1. **Executive summary** (2-3 sentences)
2. **Key points** raised by each participant
3. **Decisions or convergences** reached
4. **Remaining open questions**
5. **Suggested next steps**`,
  maxRounds: 10,
}

/** Runtime configuration — initialised from file on plugin load */
let config: PluginConfig = { ...DEFAULT_CONFIG }

// ============================================================
// Config helpers
// ============================================================

/** URL of the JSON Schema for the config file */
const configSchemaUrl =
  "https://raw.githubusercontent.com/opencode-ai/roundtable/main/docs/roundtable.schema.json"

/** Validate a partial config object, filling in missing keys with defaults. */
function validateConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    defaultTimeoutMs:
      typeof raw.defaultTimeoutMs === "number" &&
      raw.defaultTimeoutMs >= 30_000
        ? raw.defaultTimeoutMs
        : DEFAULT_CONFIG.defaultTimeoutMs,
    loopSimilarityThreshold:
      typeof raw.loopSimilarityThreshold === "number" &&
      raw.loopSimilarityThreshold >= 0 &&
      raw.loopSimilarityThreshold <= 1
        ? raw.loopSimilarityThreshold
        : DEFAULT_CONFIG.loopSimilarityThreshold,
    toolOutputPreviewMax:
      typeof raw.toolOutputPreviewMax === "number" &&
      raw.toolOutputPreviewMax >= 100
        ? raw.toolOutputPreviewMax
        : DEFAULT_CONFIG.toolOutputPreviewMax,
    defaultObserverPrompt:
      typeof raw.defaultObserverPrompt === "string" &&
      raw.defaultObserverPrompt.length > 0
        ? raw.defaultObserverPrompt
        : DEFAULT_CONFIG.defaultObserverPrompt,
    maxRounds:
      typeof raw.maxRounds === "number" && raw.maxRounds >= 1
        ? raw.maxRounds
        : DEFAULT_CONFIG.maxRounds,
  }
}

/**
 * Load configuration from roundtable.json.
 * If the file does not exist, create it with defaults.
 * If it exists but is invalid, log a warning and use hardcoded defaults.
 */
async function loadConfig(ctx: PluginInput): Promise<void> {
  try {
    const content = await readFile(configPath, "utf-8")
    const raw = JSON.parse(content)

    if (typeof raw !== "object" || !raw) {
      throw new Error("Invalid config format")
    }

    config = validateConfig(raw as Record<string, unknown>)

    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "info",
        message: "Configuration loaded",
        extra: { configPath },
      },
    })
  } catch (err) {
    // File does not exist — create it with defaults
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      try {
        const defaultWithSchema = {
          $schema: configSchemaUrl,
          ...DEFAULT_CONFIG,
        }
        await writeFile(configPath, JSON.stringify(defaultWithSchema, null, 2), "utf-8")
        config = { ...DEFAULT_CONFIG }
        await ctx.client.app.log({
          body: {
            service: "roundtable",
            level: "info",
            message: "Created default configuration",
            extra: { configPath },
          },
        })
      } catch {
        // Best-effort — fall back to defaults
        config = { ...DEFAULT_CONFIG }
      }
    } else {
      // File exists but is invalid — warn and use defaults
      try {
        await ctx.client.app.log({
          body: {
            service: "roundtable",
            level: "warn",
            message: `Invalid config, using defaults: ${err instanceof Error ? err.message : String(err)}`,
            extra: { configPath },
          },
        })
      } catch {
        // Best-effort
      }
      config = { ...DEFAULT_CONFIG }
    }
  }
}

// ============================================================
// Module-level state stores
// ============================================================

/** Map<S2 session ID → RoundtableState> */
const states = new Map<string, RoundtableState>()

/** Map<S2 session ID → setTimeout handle> for agent timeout management */
const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>()

/** Map<S2 session ID → pending promise resolvers for tool.execute awaiting debate completion */
const pendingResults = new Map<string, {
  resolve: (output: string) => void
}>()

// ============================================================
// Plugin
// ============================================================

export const RoundtablePlugin: Plugin = async (ctx) => {
  // Load config (best-effort — must not crash the plugin)
  try {
    await loadConfig(ctx)
  } catch {
    // Falls back to DEFAULT_CONFIG
  }

  // Phase 1: log-only initialization (best-effort — must not crash the plugin)
  try {
    await scanOrphanRoundtables(ctx)
  } catch (err) {
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "error",
          message: `scanOrphanRoundtables failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
    } catch {
      // Best-effort logging
    }
  }

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
          "Agents take turns discussing a topic, each seeing the full discussion history. " +
          "After all rounds, a built-in observer consolidates the debate into an executive summary.",

        args: {
          agents: tool.schema
            .array(tool.schema.string())
            .min(2)
            .describe("Agent names in speaking order (minimum 2). Example: [\"pm\", \"dev\", \"rv\"]"),
          prompt: tool.schema
            .string()
            .describe("Topic or challenge for the agents to debate"),
          rounds: tool.schema
            .number()
            .min(1)
            .describe("Number of complete rounds (each round = all agents speak once). Default: 1"),
          observer: tool.schema
            .string()
            .optional()
            .describe("Agent name for final consolidation. Omit to use the built-in observer"),
          mode: tool.schema
            .enum(["new", "extend"])
            .describe("'new' starts a fresh debate; 'extend' continues a concluded one (requires sessionID). Default: \"new\""),
          sessionID: tool.schema
            .string()
            .optional()
            .describe("S2 session ID to extend. Required only when mode is \"extend\""),
          title: tool.schema
            .string()
            .optional()
            .describe("Custom title for the child session. Default: \"Roundtable: A vs B · N round(s)\""),
        },

        async execute(args, toolCtx) {
          try {
            // Apply defaults for optional/missing args
            const rounds = args.rounds ?? 1
            const mode = args.mode ?? "new"

            switch (mode) {
              case "new": {
                if (!args.agents || args.agents.length < 2) {
                  return "Error: 'agents' with at least 2 names is required when mode is 'new'"
                }
                const validation = await validateAgents(ctx, args.agents)
                if (!validation.valid) {
                  const available = validation.available.map((a) => a.name).join(", ")
                  return [
                    "Invalid agent configuration:",
                    ...validation.errors.map((e) => `  - ${e}`),
                    `Available agents: ${available}`,
                  ].join("\n")
                }
                if (rounds > config.maxRounds) {
                  return `Error: Maximum ${config.maxRounds} rounds allowed (requested: ${rounds})`
                }
                const sessionID = await startNewRoundtable(ctx, { ...args, rounds, mode } as RoundtableArgs, toolCtx)
                // Await debate completion — this keeps the tool "loading" until the debate finishes
                const result = await new Promise<string>((resolve) => {
                  pendingResults.set(sessionID, { resolve })
                })
                return result
              }
              case "extend": {
                if (!args.sessionID) {
                  return "Error: sessionID is required when mode is 'extend'"
                }
                const sessionID = await extendRoundtable(ctx, { ...args, rounds, mode } as RoundtableArgs, toolCtx)
                const result = await new Promise<string>((resolve) => {
                  pendingResults.set(sessionID, { resolve })
                })
                return result
              }
            }
          } catch (err) {
            await ctx.client.app.log({
              body: {
                service: "roundtable",
                level: "error",
                message: `roundtable.execute error: ${err instanceof Error ? err.stack || err.message : String(err)}`,
              },
            })
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      available_agents: tool({
        description:
          "Lists all configured agents that can participate in a roundtable. " +
          "Use this to discover agent names before calling roundtable().",

        args: {},

        async execute(_args, _ctx) {
          try {
            const result = await ctx.client.app.agents()
            const names = result.data.map(
              (a: { name: string; description?: string }) => a.name,
            )
            return `Available agents: ${names.join(", ")}`
          } catch {
            return "Error: Could not fetch agent list. The server might not be ready."
          }
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
 * 2. Every name matches a configured agent
 *    (Duplicate names are allowed — two "plan" agents can debate each other)
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
  // agents is guaranteed by the execute() validation for mode:"new"
  const agents = args.agents!

  // 1. Create S2 as a standalone session (visible in session list)
  const newSession = await ctx.client.session.create({
    body: {
      title: generateDefaultTitle({ ...args, agents }),
    },
  })

  const sessionID = newSession.data.id
  const parentSessionID = toolCtx.sessionID

  // 2. Initialise in-memory state
  const state: RoundtableState = {
    sessionID,
    parentSessionID,
    agents,
    totalRounds: args.rounds,
    observer: args.observer ?? "built-in",
    prompt: args.prompt,
    currentRound: 0,
    currentAgentIndex: 0,
    phase: "active",
    history: [],
    errors: [],
    createdAt: Date.now(),
    currentGeneration: 0,
    userInterjections: [],
  }

  // Register BEFORE fallible operations — if something fails, we clean up
  states.set(sessionID, state)

  try {
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
        message: `Roundtable started in #${sessionID} (${agents.join(" → ")} · ${args.rounds} round(s))`,
        variant: "info",
      },
    })

    // 6. Return sessionID so the tool execute can await completion
    return sessionID
  } catch (err) {
    // Clean up state on failure
    states.delete(sessionID)
    throw err
  }
}

// ============================================================
// Extend Helpers
// ============================================================

/**
 * Search through session messages for a text part containing
 * the serialized [ROUNDTABLE META] state.
 */
function findSerializedState(
  messages: Array<{ info: { role: string }; parts: Part[] }>,
): string | null {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue
    for (const part of msg.parts) {
      if (part.type === "text" && part.text.includes("[ROUNDTABLE META]")) {
        return part.text
      }
    }
  }
  return null
}

/**
 * Build the extended prompt string using the heuristic from SPEC §9.
 *
 * Continuation: prompt starts with known trigger words → append to original
 * New topic: otherwise → original becomes context, new prompt is the challenge
 */
function buildExtendedPrompt(originalPrompt: string, extendPrompt: string): string {
  const continuationTriggers = [
    "debate more",
    "continue",
    "dive deeper",
    "go deeper",
    "expand on",
    "elaborate",
    "further discuss",
    "keep debating",
  ]

  const lower = extendPrompt.toLowerCase().trim()
  const isContinuation = continuationTriggers.some((trigger) => lower.startsWith(trigger))

  if (isContinuation) {
    return `Original topic: ${originalPrompt}\n\nContinuation: ${extendPrompt}`
  }

  // New topic — original becomes context
  return [
    `Previous discussion history preserved. Original topic was:`,
    `  ${originalPrompt}`,
    ``,
    `New challenge: ${extendPrompt}`,
  ].join("\n")
}

/**
 * Compare two string arrays for shallow equality (same length, same elements in order).
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ============================================================
// Extend Mode
// ============================================================

/**
 * Continue a concluded roundtable with additional rounds.
 *
 * Flow (SPEC §9):
 *   1. Fetch S2 by sessionID
 *   2. Read messages, find [ROUNDTABLE META] tag
 *   3. Deserialize state
 *   4. Validate phase was "done"
 *   5. Create new state with preserved config + accumulated rounds
 *   6. Build extended prompt (continuation vs new topic heuristic)
 *   7. Re-serialize updated state into S2
 *   8. Send to agents[0], continue normal PHASE 2 flow
 */
async function extendRoundtable(
  ctx: PluginInput,
  args: RoundtableArgs,
  _toolCtx: ToolContext,
): Promise<string> {
  const sessionID = args.sessionID!

  // 1. Fetch S2 to verify it exists and is accessible
  try {
    await ctx.client.session.get({ path: { id: sessionID } })
  } catch {
    return `Error: Session #${sessionID} not found or inaccessible. Cannot extend.`
  }

  // 2. Read S2 messages
  let messagesData
  try {
    messagesData = await ctx.client.session.messages({ path: { id: sessionID } })
  } catch {
    return `Error: Could not read messages from session #${sessionID}`
  }

  // 3. Find the [ROUNDTABLE META] tag in the messages
  const serializedRaw = findSerializedState(messagesData.data)
  if (!serializedRaw) {
    return [
      `Error: No roundtable state found in session #${sessionID}.`,
      "This session is not a roundtable or the state was lost during compaction.",
    ].join("\n")
  }

  // 4. Deserialize state
  const originalState = deserializeState(serializedRaw)
  if (!originalState) {
    return `Error: Corrupt roundtable state in session #${sessionID}. Cannot extend.`
  }

  // 5. Validate phase was "done"
  if (originalState.phase !== "done") {
    return [
      `Error: Roundtable #${sessionID} is still active (phase: ${originalState.phase}).`,
      "Cannot extend until the roundtable concludes.",
    ].join("\n")
  }

  // Validate agents match if provided
  if (args.agents && !arraysEqual(args.agents, originalState.agents)) {
    return [
      "Error: Agent mismatch.",
      `Original: ${originalState.agents.join(", ")}`,
      `Provided: ${args.agents.join(", ")}`,
      "Extend must use the same agents as the original roundtable.",
    ].join("\n")
  }

  // Optionally re-validate stored agents still exist on the server
  try {
    const storedValidation = await validateAgents(ctx, originalState.agents)
    if (!storedValidation.valid) {
      return [
        "Error: One or more agents from the original roundtable no longer exist.",
        ...storedValidation.errors.map((e) => `  - ${e}`),
      ].join("\n")
    }
  } catch {
    return "Error: Failed to validate agents. Cannot extend."
  }

  // 6. Build extended prompt
  const extendedPrompt = buildExtendedPrompt(originalState.prompt, args.prompt)

  // 7. Create new state with preserved config + accumulated rounds
  const newState: RoundtableState = {
    sessionID: originalState.sessionID,
    parentSessionID: originalState.parentSessionID,
    agents: originalState.agents,
    totalRounds: originalState.totalRounds + args.rounds,
    observer: originalState.observer,
    prompt: extendedPrompt,
    currentRound: originalState.currentRound,
    currentAgentIndex: 0,
    phase: "active",
    history: [...originalState.history],
    errors: [...originalState.errors],
    createdAt: Date.now(),
    currentGeneration: 0,
    userInterjections: [...(originalState.userInterjections ?? [])],
  }

  // Register BEFORE fallible operations
  states.set(sessionID, newState)

  try {
    // 8. Re-serialize updated state into S2 (replaces old meta)
    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: serializeState(newState) }],
      },
    })

    // 9. Update S2 title to reflect extended rounds
    const agentList = originalState.agents.join(" vs ")
    await ctx.client.session.update({
      path: { id: sessionID },
      body: {
        title: `Roundtable: ${agentList} (R${newState.currentRound + 1}/${newState.totalRounds})`,
      },
    })

    // 10. Send extended prompt to agents[0]
    await sendToAgent(ctx, newState)

    // 11. Toast
    await ctx.client.tui.showToast({
      body: {
        message: `Roundtable #${sessionID} extended — ${args.rounds} more round(s) (${originalState.agents.join(" → ")})`,
        variant: "info",
      },
    })

    // 12. Return sessionID so the tool execute can await completion
    return sessionID
  } catch (err) {
    // Clean up state on failure
    states.delete(sessionID)
    throw err
  }
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

  // 2. Collect user interjections (SPEC 7.4) — user messages in S2
  const userMsgs = messages.filter(
    (m: { info: { role: string } }) => m.info.role === "user",
  )
  const previousInterjectionCount = state.userInterjections.length
  for (const msg of userMsgs) {
    for (const part of msg.parts) {
      if (part.type === "text" && !part.text.includes("[ROUNDTABLE META]")) {
        // Avoid duplicating interjections already captured
        if (!state.userInterjections.includes(part.text)) {
          state.userInterjections.push(part.text)
        }
      }
    }
  }

  // 3. Find the latest assistant message (the one that just finished)
  const assistantMsgs = messages.filter(
    (m: { info: { role: string } }) => m.info.role === "assistant",
  )
  if (assistantMsgs.length === 0) return // no assistant response yet

  const latestMsg = assistantMsgs[assistantMsgs.length - 1]

  // 4. Duplicate session.idle guard: skip if we already processed this message
  if (state.lastProcessedMsgId === latestMsg.info.id) return
  state.lastProcessedMsgId = latestMsg.info.id

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

    // Debug log for turn completion
    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Turn complete: ${entry.agent} (R${state.currentRound + 1})`,
        extra: {
          sessionID: state.sessionID,
          agent: entry.agent,
          round: state.currentRound + 1,
          responseLength: entry.response.length,
          toolCallCount: entry.toolCalls.length,
          hasError: entry.hasError,
        },
      },
    })

    // 6. Loop detection (compare last two responses)
    if (detectLoop(state.history)) {
      state.errors.push("Loop detected — agents reached an impasse")
      state.phase = "done"
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Loop detected — finalizing early",
          extra: {
            sessionID: state.sessionID,
            similarity: config.loopSimilarityThreshold,
          },
        },
      })
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
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "All rounds complete — transitioning to observer",
          extra: {
            sessionID: state.sessionID,
            totalRounds: state.totalRounds,
          },
        },
      })
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
  try {
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

    // 2. Increment generation and set timeout
    state.currentGeneration++
    const capturedGeneration = state.currentGeneration

    const handle = setTimeout(async () => {
      // Delete handle FIRST to prevent stale-callback re-entry
      timeoutHandles.delete(state.sessionID)

      // If generation changed, the agent already finished — bail out
      if (state.currentGeneration !== capturedGeneration) return

      try {
        await ctx.client.session.abort({
          path: { id: state.sessionID },
        })
        state.errors.push(
          `Agent "${agent}" timed out after ${config.defaultTimeoutMs / 1000}s`,
        )
      } catch {
        // Session may already be done or aborted — ignore
      }
    }, config.defaultTimeoutMs)

    timeoutHandles.set(state.sessionID, handle)

    // 3. Update S2 title to reflect current round
    await updateSessionTitle(ctx, state)

    // 4. Debug log
    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Turn started: ${agent} (R${state.currentRound + 1}/${state.totalRounds})`,
        extra: {
          sessionID: state.sessionID,
          agent,
          round: state.currentRound + 1,
          totalRounds: state.totalRounds,
          generation: state.currentGeneration,
        },
      },
    })
  } catch (err) {
    state.errors.push(
      `Failed to send to agent "${state.agents[state.currentAgentIndex]}": ${err instanceof Error ? err.message : String(err)}`,
    )
    const handle = timeoutHandles.get(state.sessionID)
    if (handle) {
      clearTimeout(handle)
      timeoutHandles.delete(state.sessionID)
    }
  }
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
  try {
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

    // Debug log
    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Observer prompt sent: ${state.observer}`,
        extra: {
          sessionID: state.sessionID,
          observer: state.observer,
        },
      },
    })
  } catch (err) {
    state.errors.push(
      `Failed to send observer prompt: ${err instanceof Error ? err.message : String(err)}`,
    )
    state.phase = "aborted"
    await finalizeRoundtable(ctx, state)
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

  // Clear any pending timeout (defensive — normally already cleared by idle handler)
  const timeoutHandle = timeoutHandles.get(sessionID)
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandles.delete(sessionID)
  }

  try {
    // 1. Build consolidated summary from history
    const summary = buildConsolidatedSummary(state)

    // 2. Resolve the pending tool.execute promise — this returns the result
    //    to the orchestrator agent that called roundtable()
    const pending = pendingResults.get(sessionID)
    if (pending) {
      pending.resolve(summary)
      pendingResults.delete(sessionID)
    }

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
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `State cleaned up for session #${sessionID}`,
          extra: { sessionID, phase: state.phase },
        },
      })
    } catch {
      // Best-effort
    }
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
  // Phase guard: if the observer is failing, abort rather than skip
  if (state.phase === "observing" || state.phase === "done") {
    state.phase = "aborted"
    await finalizeRoundtable(ctx, state)
    return
  }

  const agent = state.agents[state.currentAgentIndex]
  const errorMsg =
    event.type === "session.error" && event.properties.error
      ? typeof event.properties.error === "object"
        ? (event.properties.error as { message?: string }).message ?? JSON.stringify(event.properties.error)
        : String(event.properties.error)
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
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `Agent skipped due to error`,
          extra: {
            sessionID: state.sessionID,
            failedAgent: agent,
            nextAgent: state.agents[state.currentAgentIndex],
            round: state.currentRound + 1,
          },
        },
      })
    } catch {
      // Best-effort
    }
    await sendToAgent(ctx, state)
  } else if (state.currentRound + 1 < state.totalRounds) {
    // Move to next round
    state.currentRound++
    state.currentAgentIndex = 0
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `Agent skipped due to error — moving to next round`,
          extra: {
            sessionID: state.sessionID,
            failedAgent: agent,
            round: state.currentRound + 1,
          },
        },
      })
    } catch {
      // Best-effort
    }
    await sendToAgent(ctx, state)
  } else {
    // All agents failed — abort and finalize
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
    // finalizeRoundtable injects partial result into S1, adds delimiter, cleans up state
    await finalizeRoundtable(ctx, state)
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
  // Clear any pending timeout for this session
  const handle = timeoutHandles.get(state.sessionID)
  if (handle) {
    clearTimeout(handle)
    timeoutHandles.delete(state.sessionID)
  }

  if (deletedSessionID === state.sessionID) {
    // ── S2 was deleted → resolve pending promise with partial result ──
    state.phase = "aborted"

    const partialSummary = buildConsolidatedSummary(state)
    const output = [
      "[Roundtable interrupted — session closed]",
      "Partial history up to interruption:",
      "",
      partialSummary,
    ].join("\n")

    const pending = pendingResults.get(state.sessionID)
    if (pending) {
      pending.resolve(output)
      pendingResults.delete(state.sessionID)
    }

    try {
      await ctx.client.tui.showToast({
        body: {
          message: "Roundtable interrupted",
          variant: "warning",
        },
      })
    } catch {
      // Best-effort
    }
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `S2 deleted — pending promise resolved with partial result`,
          extra: { sessionID: deletedSessionID, parentSessionID: state.parentSessionID },
        },
      })
    } catch {
      // Best-effort
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
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "S1 deleted — S2 aborted",
          extra: { sessionID: state.sessionID, parentSessionID: deletedSessionID },
        },
      })
    } catch {
      // Best-effort
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

  lines.push(`Topic: ${state.prompt}`)
  lines.push(`Your role: ${agent} · Round ${state.currentRound + 1}/${state.totalRounds}`)
  lines.push(`Participants: ${state.agents.join(", ")}`)
  lines.push("")

  // User interjections are visible in S2 directly — no need to re-inject
  // (SPEC 7.4: user messages become part of the session context)

  const isLastAgent = state.currentAgentIndex === state.agents.length - 1
  const isLastRound = state.currentRound === state.totalRounds - 1
  if (isLastAgent && isLastRound) {
    lines.push("This is the final speech. Summarize your position at the end.")
    lines.push("")
  }

  lines.push(`Your turn, ${agent}.`)
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
  const observerPrompt = config.defaultObserverPrompt

  if (observer === "built-in") {
    return observerPrompt
  }

  return (
    `You are an impartial roundtable observer.\n` +
    `Your role: ${observer}. Provide an executive summary of the debate.\n\n` +
    observerPrompt
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

  return intersection / union.size > config.loopSimilarityThreshold
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
      outputPreview = part.state.output.slice(0, config.toolOutputPreviewMax)
      break
    case "error":
      outputPreview = (part.state.output ?? "(unknown error)").slice(0, config.toolOutputPreviewMax)
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
      level: "debug",
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
function generateDefaultTitle(args: RoundtableArgs & { agents: string[] }): string {
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
  // Compact single-line JSON to minimize session visual noise.
  // This message is internal — it survives restarts and enables extend mode.
  const json = JSON.stringify(state)
  return `[ROUNDTABLE META] ${json} [/ROUNDTABLE META]`
}

/**
 * Deserialize roundtable state from a tagged string.
 *
 * Parses the JSON payload between [ROUNDTABLE META] and [/ROUNDTABLE META]
 * tags, validates required fields, and returns the state.
 * Returns null if parsing or validation fails.
 */
function deserializeState(raw: string): RoundtableState | null {
  try {
    const startTag = "[ROUNDTABLE META]"
    const endTag = "[/ROUNDTABLE META]"

    const startIdx = raw.indexOf(startTag)
    if (startIdx === -1) return null

    const contentStart = startIdx + startTag.length
    const endIdx = raw.indexOf(endTag, contentStart)
    if (endIdx === -1) return null

    const json = raw.slice(contentStart, endIdx).trim()
    if (!json) return null

    const parsed = JSON.parse(json)

    // — Validate required fields —
    if (typeof parsed !== "object" || !parsed) return null
    if (typeof parsed.sessionID !== "string") return null
    if (typeof parsed.parentSessionID !== "string") return null
    if (!Array.isArray(parsed.agents)) return null
    if (typeof parsed.totalRounds !== "number") return null
    if (typeof parsed.prompt !== "string") return null

    // — Return with defaults for optional/missing fields —
    return {
      sessionID: parsed.sessionID,
      parentSessionID: parsed.parentSessionID,
      agents: parsed.agents,
      totalRounds: parsed.totalRounds,
      observer: parsed.observer ?? "built-in",
      prompt: parsed.prompt,
      currentRound: parsed.currentRound ?? 0,
      currentAgentIndex: parsed.currentAgentIndex ?? 0,
      phase: parsed.phase ?? "done",
      history: parsed.history ?? [],
      errors: parsed.errors ?? [],
      createdAt: parsed.createdAt ?? 0,
      currentGeneration: parsed.currentGeneration ?? 0,
      userInterjections: parsed.userInterjections ?? [],
      lastProcessedMsgId: parsed.lastProcessedMsgId ?? undefined,
    }
  } catch {
    return null
  }
}
