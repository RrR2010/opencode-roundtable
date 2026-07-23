import { type Plugin, type PluginInput, tool, type ToolContext } from "@opencode-ai/plugin"
import type { RoundtableArgs, Event as RoundtableEvent } from "./src/types"
import { loadConfig } from "./src/config"
import { states, timeoutHandles, pendingResults, roundtableLocks } from "./src/state"
import { getSessionIdFromEvent, validateAgents, scanOrphanRoundtables } from "./src/utils"
import { startNewRoundtable, extendRoundtable, processNextTurn, handleAgentError, handleSessionDeleted } from "./src/handlers"

export const RoundtablePlugin: Plugin = async (ctx) => {
  try {
    await ctx.client.app.log({
      body: { service: "roundtable", level: "debug", message: "PLUGIN_LOADED" },
    })
  } catch { /* best-effort */ }

  try {
    await loadConfig(ctx)
  } catch { /* best-effort */ }

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
    } catch { /* best-effort */ }
  }

  return {
    event: async ({ event }: { event: { type: string; properties: Record<string, unknown> } }) => {
      const sessionID = getSessionIdFromEvent(event)
      if (!sessionID || !states.has(sessionID)) return

      const state = states.get(sessionID)!

      switch (event.type) {
        case "session.idle": {
          const handle = timeoutHandles.get(sessionID)
          if (handle) { clearTimeout(handle); timeoutHandles.delete(sessionID) }
          ctx.client.app.log({
            body: {
              service: "roundtable", level: "debug",
              message: "session.idle event",
              extra: { sessionID, eventProps: JSON.stringify(event.properties) },
            },
          }).catch(() => {})
          await processNextTurn(ctx, state)
          break
        }
        case "session.status": {
          ctx.client.app.log({
            body: {
              service: "roundtable", level: "debug",
              message: "session.status event",
              extra: { sessionID, eventProps: JSON.stringify(event.properties) },
            },
          }).catch(() => {})
          break
        }
        case "session.error": {
          await handleAgentError(ctx, state, event as RoundtableEvent)
          break
        }
        case "session.deleted": {
          const deletedID = (event.properties.info as { id?: string })?.id
          if (deletedID) await handleSessionDeleted(ctx, state, deletedID)
          break
        }
      }
    },

    "experimental.session.compacting": async (
      _input: { sessionID: string },
      _output: { context: string[]; prompt?: string },
    ) => {
      // Phase 4: will re-inject [ROUNDTABLE META] state during compaction
    },

    tool: {
      roundtable: tool({
        description:
          "Starts a multi-agent roundtable debate where agents discuss a topic turn by turn. " +
          "After all rounds, a built-in observer consolidates the discussion into an executive summary.\n\n" +
          "Returns an object with { sessionID, summary } after the debate concludes.\n\n" +
          "Note: this tool injects system-level prompts into each agent's context during " +
          "the debate (role-setting, topic, turn routing, and lifecycle signals).\n\n" +
          "IMPORTANT: This tool requires 2+ agents. For single-agent tasks, use a regular " +
          "session prompt instead — do NOT use roundtable.\n\n" +
          "Choosing agents: select agents based on their expertise (e.g., pm for product decisions, " +
          "dev for technical trade-offs, rv for code review). You can also specify in the prompt " +
          "what each agent should focus on (e.g., 'pm: focus on cost; dev: focus on maintainability').\n\n" +
          "Multiple rounds: for complex topics, use 2+ rounds and INCLUDE per-round focus " +
          "instructions IN the prompt itself (e.g., prompt: 'Round 1: list pros. Round 2: " +
          "list cons. Round 3: propose an implementation plan'). This way all agents see " +
          "the full agenda. The default is 1 round.",

        args: {
          agents: tool.schema
            .array(tool.schema.string())
            .min(2)
            .describe(
              "Agent names in speaking order (minimum 2). For single-agent tasks, use a regular " +
              "session — do NOT use roundtable. Choose agents based on their expertise and " +
              "think about the logical sequence: who should speak first to set context, " +
              "who should react next, who should close. " +
              "Example: [\"pm\", \"dev\", \"rv\"] means pm speaks first, then dev, then rv.",
            ),
          prompt: tool.schema
            .string()
            .describe(
              "Topic or challenge for the agents to debate. For multi-round debates, " +
              "include per-round instructions here (e.g., 'Round 1: pros. Round 2: cons. " +
              "Round 3: plan.'). All agents will see this and follow the round structure.",
            ),
          rounds: tool.schema
            .number()
            .min(1)
            .max(50)
            .describe(
              "Number of complete rounds (each round = all agents speak once). " +
              "Default: 1. Max: 50. For complex topics with 2+ rounds, include per-round focus " +
              "instructions in the prompt parameter so all agents see the agenda.",
            ),
          observer: tool.schema
            .string()
            .describe(
              "Agent name for final consolidation. The observer does not debate — it " +
              "summarizes after all rounds. Omit to use the built-in observer.",
            ),
          sessionID: tool.schema
            .string()
            .describe(
              "Session ID (format: ses_xxxx) from a previous roundtable call to " +
              "continue a concluded debate. Prefer extend over starting a new " +
              "roundtable — it reuses accumulated context, saving exploration tokens. " +
              "Omit this parameter and pass agents + prompt to start a fresh debate.",
            ),
          title: tool.schema
            .string()
            .describe(
              "Custom title for the session (max 200 chars). If omitted, auto-generated " +
              "as \"(Roundtable) - {first 80 chars of prompt, truncated at word boundary}\".",
            ),
          observerPrompt: tool.schema
            .string()
            .describe(
              "Override the default observer consolidation prompt. Use this to control " +
              "the format and focus of the final summary — e.g., ask the observer to " +
              "save a detailed report to file, focus on technical decisions only, " +
              "output as JSON, extract action items, etc. " +
              "If omitted, the default observer prompt is used (executive summary).",
            ),
        },

        async execute(args: Record<string, unknown>, toolCtx: ToolContext) {
          try {
            if (states.has(toolCtx.sessionID)) {
              return `Cannot nest roundtables. You are already inside roundtable #${toolCtx.sessionID}. Wait for it to complete before starting another.`
            }

            const rounds = (args.rounds as number) ?? 1

            if (args.sessionID && typeof args.sessionID === "string" && args.sessionID.trim()) {
              if (args.agents) return "Error: pass either sessionID or agents, not both"
              const sid = await extendRoundtable(ctx, args as unknown as RoundtableArgs, toolCtx)
              if (sid.startsWith("Error:") || sid.startsWith("Invalid")) return sid
              toolCtx.metadata({ title: "Roundtable (extended)", metadata: { sessionId: sid } })
              toolCtx.abort.addEventListener("abort", () => {
                ctx.client.session.abort({ path: { id: sid } }).catch(() => {})
                const p = pendingResults.get(sid)
                if (p) { p.resolve("[Roundtable cancelled — user aborted]"); pendingResults.delete(sid) }
                roundtableLocks.delete(sid)
              }, { once: true })
              const result = await new Promise<string>((resolve) => pendingResults.set(sid, { resolve }))
              return result
            }

            if (!args.agents || !Array.isArray(args.agents) || args.agents.length < 2) {
              return "Error: 'agents' with at least 2 names is required"
            }

            const validation = await validateAgents(ctx, args.agents as string[])
            if (!validation.valid) {
              const avail = validation.available.map((a) => a.name).join(", ")
              return ["Invalid agent configuration:", ...validation.errors.map((e) => `  - ${e}`), `Available agents: ${avail}`].join("\n")
            }
            if (rounds > 50) return "Error: Maximum 50 rounds allowed"

            const sid = await startNewRoundtable(ctx, { ...args, rounds } as RoundtableArgs, toolCtx)
            toolCtx.metadata({ title: `Roundtable: ${(args.agents as string[])?.join(" → ")}`, metadata: { sessionId: sid } })
            const abortHandler = () => {
              const s = states.get(sid)
              if (s) s.userInitiatedAbort = true
              ctx.client.session.abort({ path: { id: sid } }).catch(() => {})
              const pending = pendingResults.get(sid)
              if (pending) {
                pending.resolve("[Roundtable cancelled — user aborted]")
                pendingResults.delete(sid)
              }
              roundtableLocks.delete(sid)
            }
            toolCtx.abort.addEventListener("abort", abortHandler, { once: true })
            const result = await new Promise<string>((resolve) => pendingResults.set(sid, { resolve }))
            toolCtx.abort.removeEventListener("abort", abortHandler)
            return result
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
      }),

      available_agents: tool({
        description:
          "Lists all configured agents and their roles. " +
          "Returns a formatted list of agent names (e.g., \"Available agents: pm, dev, rv\"). " +
          "Use this to choose which agents should participate in a roundtable " +
          "based on their descriptions — then call roundtable() with your selection.",

        args: {},

        async execute() {
          try {
            const result = await ctx.client.app.agents()
            const names = result.data.map((a: { name: string }) => a.name)
            return `Available agents: ${names.join(", ")}`
          } catch {
            return "Error: Could not fetch agent list. The server might not be ready."
          }
        },
      }),

      active_roundtables: tool({
        description:
          "Lists all active roundtables with their status. " +
          "Each entry shows session ID, agents, current round, and phase. " +
          "Returns clickable session IDs that can be used to navigate.",

        args: {},

        async execute() {
          const active: string[] = []
          for (const [sid, s] of states) {
            const status = s.phase === "active" ? "debating" :
              s.phase === "observing" ? "consolidating" :
              s.phase === "done" ? "concluded" : s.phase
            active.push(`- #${sid} · ${s.agents.join("→")} (R${s.currentRound + 1}/${s.totalRounds}) · ${status}`)
          }
          if (active.length === 0) return "No active roundtables."
          return `Active roundtables:\n${active.join("\n")}`
        },
      }),
    },
  } as unknown as ReturnType<Plugin>
}
