import type { RoundtableState } from "./types"
import { getConfig } from "./config"

export function buildAgentPrompt(state: RoundtableState, agent: string): string {
  const lines: string[] = []
  const agentList = state.agents.join(" → ")
  const roundInfo = `Round ${state.currentRound + 1} of ${state.totalRounds} · Current agent: ${agent}`

  if (state.history.length === 0) {
    lines.push(`[RULES] Roundtable: ${agentList}, ${state.totalRounds} round(s). Topic below.`)
    lines.push(`[Topic] ${state.prompt}`)
    lines.push("")
  }

  lines.push(roundInfo)

  const isLastAgent = state.currentAgentIndex === state.agents.length - 1
  const isLastRound = state.currentRound === state.totalRounds - 1
  if (isLastAgent && isLastRound) {
    lines.push("[TURN] FINAL — finalize your thoughts")
  }

  return lines.join("\n")
}

export function buildObserverPrompt(state: RoundtableState, observer: "built-in" | string): string {
  const observerPrompt = state.observerPrompt ?? getConfig().defaultObserverPrompt

  if (observer === "built-in") return observerPrompt

  return (
    `You are an impartial roundtable observer.\n` +
    `Your role: ${observer}.\n\n` +
    observerPrompt
  )
}
