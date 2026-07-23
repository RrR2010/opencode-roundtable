import type { RoundtableState } from "./types"
import { getConfig } from "./config"

export function buildAgentPrompt(state: RoundtableState, agent: string): string {
  const lines: string[] = []
  const orderStr = state.agents.join(" → ")

  if (state.currentRound === 0 && state.currentAgentIndex === 0) {
    lines.push(
      `You are participating on a multi-agent discussion — ${state.totalRounds} round(s), ` +
      `speaking order: ${orderStr}.`,
      ``,
      `Topic: ${state.prompt}`,
      ``,
    )
  }

  lines.push(`--- Round ${state.currentRound + 1} of ${state.totalRounds} — ${agent}'s turn ---`)

  const isLastAgent = state.currentAgentIndex === state.agents.length - 1
  const isLastRound = state.currentRound === state.totalRounds - 1
  if (isLastAgent && isLastRound) {
    lines.push("This is the final turn — wrap up your arguments.")
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
