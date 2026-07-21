import { readFile, writeFile, unlink, readdir, mkdir } from "fs/promises"
import { join } from "path"
import os from "os"
import type { RoundtableState } from "./types"

const statesDir = (() => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const base = xdgConfigHome ? join(xdgConfigHome, "opencode") : join(os.homedir(), ".config", "opencode")
  return join(base, "roundtable-states")
})()

export const states = new Map<string, RoundtableState>()
export const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>()
export const pendingResults = new Map<string, {
  resolve: (output: string) => void
}>()

function stateFilePath(sessionID: string): string {
  return join(statesDir, `${sessionID}.json`)
}

export async function saveStateFile(state: RoundtableState): Promise<void> {
  try {
    await mkdir(statesDir, { recursive: true })
  } catch { /* already exists */ }
  const filePath = stateFilePath(state.sessionID)
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8")
}

export async function loadStateFile(sessionID: string): Promise<RoundtableState | null> {
  try {
    const content = await readFile(stateFilePath(sessionID), "utf-8")
    const parsed = JSON.parse(content)
    if (typeof parsed !== "object" || !parsed) return null
    if (typeof parsed.sessionID !== "string") return null
    if (typeof parsed.parentSessionID !== "string") return null
    if (!Array.isArray(parsed.agents)) return null
    if (typeof parsed.totalRounds !== "number") return null
    if (typeof parsed.prompt !== "string") return null
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
      lastProcessedMsgId: parsed.lastProcessedMsgId ?? undefined,
    }
  } catch {
    return null
  }
}

export async function deleteStateFile(sessionID: string): Promise<void> {
  try {
    await unlink(stateFilePath(sessionID))
  } catch { /* best-effort */ }
}

export async function listStateFiles(): Promise<string[]> {
  try {
    const entries = await readdir(statesDir)
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.replace(/\.json$/, ""))
  } catch {
    return []
  }
}
