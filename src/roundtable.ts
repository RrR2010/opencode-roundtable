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
import type { Event } from "@opencode-ai/sdk"

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
// Plugin
// ============================================================

export const RoundtablePlugin: Plugin = async (ctx) => {
  /** Map<S2 session ID, RoundtableState> */
  const states = new Map<string, RoundtableState>()

  // Phase 1: log-only initialization
  await scanOrphanRoundtables(ctx, states)

  return {
    event: async ({ event }) => {
      const sessionID = getSessionIdFromEvent(event)
      if (!sessionID || !states.has(sessionID)) return

      // Phase 1: event handler shell — acknowledge receipt only
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `Event received for active roundtable: ${event.type}`,
          extra: { sessionID, eventType: event.type },
        },
      })

      // Phase 2+ will dispatch:
      //   event.type === "session.idle"    → processNextTurn()
      //   event.type === "session.error"   → handleAgentError()
      //   event.type === "session.deleted" → handleSessionDeleted()
    },

    "experimental.session.compacting": async (
      _input: { sessionID: string },
      _output: { context: string[]; prompt?: string },
    ) => {
      // Phase 1: stub — will re-inject [ROUNDTABLE META] state in Phase 4
      // The compaction hook preserves critical state during session compaction
      // so the roundtable can survive token-limit compression.
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
              return startNewRoundtable(ctx, args as RoundtableArgs, toolCtx, states)
            case "extend": {
              if (!args.sessionID) {
                return "Error: sessionID is required when mode is 'extend'"
              }
              return extendRoundtable(ctx, args as RoundtableArgs, toolCtx, states)
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
// Phase 1 Stubs  (full implementations in Phases 2+)
// ============================================================

/**
 * Create a new roundtable session (S2) and start the debate.
 */
async function startNewRoundtable(
  _ctx: PluginInput,
  args: RoundtableArgs,
  _toolCtx: ToolContext,
  _states: Map<string, RoundtableState>,
): Promise<string> {
  const agentList = args.agents.join(" → ")
  return [
    `[Phase 1] Roundtable validated: ${agentList} · ${args.rounds} round(s).`,
    "Session creation, agent sequencing, and debate execution will be implemented in Phase 2.",
  ].join("\n")
}

/**
 * Continue a concluded roundtable with additional rounds.
 */
async function extendRoundtable(
  _ctx: PluginInput,
  args: RoundtableArgs,
  _toolCtx: ToolContext,
  _states: Map<string, RoundtableState>,
): Promise<string> {
  return [
    `[Phase 1] Extend mode validated. Session: ${args.sessionID}, rounds: ${args.rounds}.`,
    "Full extend flow will be implemented in Phase 5.",
  ].join("\n")
}

/**
 * Process the next turn in the round-robin sequence.
 * Called when `session.idle` fires on S2.
 */
async function processNextTurn(
  _ctx: PluginInput,
  _state: RoundtableState,
): Promise<void> {
  // Phase 2: read messages, build history, determine next agent or finalize
}

/**
 * Send a prompt to a specific agent in the roundtable session.
 */
async function sendToAgent(
  _ctx: PluginInput,
  _state: RoundtableState,
  _agent: string,
  _prompt: string,
): Promise<void> {
  // Phase 2: session.prompt({ agent, parts })
}

/**
 * Finalize the roundtable: inject result into S1, delimit S2, clean up.
 */
async function finalizeRoundtable(
  _ctx: PluginInput,
  _state: RoundtableState,
): Promise<void> {
  // Phase 3: inject noReply in S1, delimiter in S2, update title, toast
}

/**
 * Handle an agent error (provider failure, timeout, etc.).
 */
async function handleAgentError(
  _ctx: PluginInput,
  _state: RoundtableState,
): Promise<void> {
  // Phase 4: log error, skip to next agent, toast
}

/**
 * Handle session deletion (S2 closed by user, or S1 closed).
 */
async function handleSessionDeleted(
  _ctx: PluginInput,
  _state: RoundtableState,
  _deletedSessionID: string,
): Promise<void> {
  // Phase 4: inject partial history into S1, clean up
}

/**
 * Build the structured prompt sent to each agent on their turn.
 *
 * Format from SPEC §6:
 *   ╔══ ROUNDTABLE ═══╗
 *   Topic: {prompt}
 *   Your role: {agentName}
 *   ...
 */
function buildAgentPrompt(
  state: RoundtableState,
  agent: string,
): string {
  // Phase 2: template formatting from SPEC §6
  void state, void agent
  return "" // stub
}

/**
 * Build the observer prompt from the full debate history.
 */
function buildObserverPrompt(
  state: RoundtableState,
  observer?: string,
): string {
  // Phase 3: format history into observer prompt
  void state, void observer
  return "" // stub
}

/**
 * Extract the latest assistant response text from session messages.
 * Returns null if no assistant response is found.
 */
function extractResponse(
  _messages: unknown[],
): string | null {
  // Phase 3: parse messages for latest assistant text part
  return null // stub
}

/**
 * Detect debate loop using Jaccard similarity of character bigrams.
 * Returns true if similarity exceeds LOOP_SIMILARITY_THRESHOLD.
 */
function detectLoop(
  _history: HistoryEntry[],
): boolean {
  // Phase 6: Jaccard bigram comparison
  return false // stub
}

/**
 * Build a ToolCallSummary from a tool part in session messages.
 */
function buildToolSummary(
  _part: unknown,
): ToolCallSummary {
  // Phase 6: extract tool name + preview
  return { toolName: "", outputPreview: "" } // stub
}

/**
 * Inject the "━━━ Roundtable Concluded ━━━" delimiter into S2.
 */
async function injectRoundtableDelimiter(
  _ctx: PluginInput,
  _sessionID: string,
): Promise<void> {
  // Phase 3: session.prompt({ noReply: true, parts: [...] })
}

/**
 * Scan orphan roundtables on plugin initialization.
 *
 * Phase 1: log only — no actual scanning yet.
 * Phase 4: list sessions, find [ROUNDTABLE META] tags, notify or clean up.
 */
async function scanOrphanRoundtables(
  ctx: PluginInput,
  _states: Map<string, RoundtableState>,
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
 * Format:
 *   [ROUNDTABLE META]
 *   {JSON}
 *   [/ROUNDTABLE META]
 */
function serializeState(state: RoundtableState): string {
  // Phase 5: JSON.stringify with tags
  void state
  return "" // stub
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
