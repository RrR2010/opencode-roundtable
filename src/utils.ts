import type { Part, HistoryEntry, ToolCallSummary, RoundtableState, RoundtableArgs } from "./types"
import { getConfig } from "./config"
import type { PluginInput } from "@opencode-ai/plugin"
import { pendingResults, listStateFiles, loadStateFile, states, saveStateFile } from "./state"

export function generateDefaultTitle(args: RoundtableArgs & { agents: string[] }): string {
  if (args.title) return args.title
  const summary = args.prompt.length > 60 ? args.prompt.slice(0, 57) + "..." : args.prompt
  return `(Roundtable) - ${summary}`
}

export function getSessionIdFromEvent(event: { type: string; properties: Record<string, unknown> }): string | undefined {
  if (!("properties" in event)) return undefined
  const props = event.properties as Record<string, unknown>
  if (typeof props.sessionID === "string") return props.sessionID
  if (props.info && typeof props.info === "object") {
    const info = props.info as { id?: string }
    if (info.id) return info.id
  }
  return undefined
}

export async function validateAgents(
  ctx: PluginInput,
  agentNames: string[],
): Promise<{ valid: boolean; available: { name: string; description?: string }[]; errors: string[] }> {
  const errors: string[] = []
  if (agentNames.length < 2) {
    errors.push("At least 2 agents are required")
    return { valid: false, available: [], errors }
  }

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

  const availableNames = new Set(available.map((a) => a.name))
  for (const name of agentNames) {
    if (!availableNames.has(name)) errors.push(`Agent "${name}" not found`)
  }

  return { valid: errors.length === 0, available, errors }
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function detectLoop(history: HistoryEntry[]): boolean {
  if (history.length < 2) return false
  const last = history[history.length - 1].response
  const prev = history[history.length - 2].response

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    const cleaned = s.replace(/[\s\n\r]+/g, " ")
    for (let i = 0; i < cleaned.length - 1; i++) set.add(cleaned.slice(i, i + 2))
    return set
  }

  const lastBigrams = bigrams(last)
  const prevBigrams = bigrams(prev)
  let intersection = 0
  for (const b of lastBigrams) if (prevBigrams.has(b)) intersection++

  const union = new Set([...lastBigrams, ...prevBigrams])
  if (union.size === 0) return false
  return intersection / union.size > getConfig().loopSimilarityThreshold
}

export function extractResponse(parts: Part[]): string | null {
  for (const part of parts) if (part.type === "text") return part.text
  return null
}

export function buildToolSummary(part: Part): ToolCallSummary | null {
  if (part.type !== "tool") return null
  const toolName = (part as unknown as { tool: string }).tool
  const state = (part as unknown as { state: { status: string; output?: string } }).state
  let outputPreview: string
  switch (state.status) {
    case "completed":
      outputPreview = state.output!.slice(0, getConfig().toolOutputPreviewMax)
      break
    case "error":
      outputPreview = (state.output ?? "(unknown error)").slice(0, getConfig().toolOutputPreviewMax)
      break
    case "running":
    case "pending":
      outputPreview = `(${state.status})`
      break
    default:
      outputPreview = "(unknown)"
  }
  return { toolName, outputPreview }
}

export function buildToolSummaries(parts: Part[]): ToolCallSummary[] {
  const summaries: ToolCallSummary[] = []
  for (const part of parts) {
    const summary = buildToolSummary(part)
    if (summary) summaries.push(summary)
  }
  return summaries
}

export function buildConsolidatedSummary(state: RoundtableState): string {
  const observerEntry = [...state.history].reverse().find(e => e.agent === "observer")

  if (observerEntry) {
    return observerEntry.response
  }

  const lines: string[] = []
  lines.push(`━━━ Roundtable ${state.errors.length > 0 ? "Aborted" : "Concluded"} ━━━`)
  lines.push(`Topic: ${state.prompt}`)
  lines.push(`Participants: ${state.agents.join(", ")}`)
  if (state.errors.length > 0) lines.push(`Errors: ${state.errors.join("; ")}`)
  return lines.join("\n")
}

export async function injectRoundtableDelimiter(
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
    body: { noReply: true, parts: [{ type: "text", text: delimiter }] },
  })
}

export function buildExtendedPrompt(_originalPrompt: string, extendPrompt: string): string {
  return `Continue for more rounds. Focus on:\n${extendPrompt}`
}

export async function navigateToSession(
  ctx: PluginInput,
  targetID: string,
  _parentID?: string,
): Promise<boolean> {
  try {
    if (typeof (ctx.client.tui as any).selectSession === "function") {
      await (ctx.client.tui as any).selectSession({ sessionID: targetID })
      return true
    }
    await (ctx.client.tui.publish as any)({
      body: {
        type: "tui.session.select",
        properties: { sessionID: targetID },
      },
    })
    return true
  } catch {
    return false
  }
}

export async function scanOrphanRoundtables(ctx: PluginInput): Promise<void> {
  const sessionIDs = await listStateFiles()
  let loaded = 0
  let errors = 0
  for (const sid of sessionIDs) {
    try {
      const state = await loadStateFile(sid)
      if (state) {
        states.set(sid, state)
        loaded++
      }
    } catch {
      errors++
    }
  }
  await ctx.client.app.log({
    body: {
      service: "roundtable",
      level: "debug",
      message: `scanOrphanRoundtables: ${loaded} state(s) loaded, ${errors} error(s)`,
      extra: { loaded, errors, total: sessionIDs.length },
    },
  })
}
