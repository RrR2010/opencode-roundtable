export interface Part {
  type: string
  text?: string
}

export interface Event {
  type: string
  properties: {
    sessionID?: string
    info?: { id?: string }
    error?: unknown
  }
}

export interface RoundtableState {
  sessionID: string
  parentSessionID: string
  agents: string[]
  totalRounds: number
  observer: "built-in" | string
  prompt: string
  currentRound: number
  currentAgentIndex: number
  phase: Phase
  history: HistoryEntry[]
  errors: string[]
  createdAt: number
  lastProcessedMsgId?: string
  currentGeneration: number
  observerPrompt?: string
  userInitiatedAbort?: boolean
}

export interface HistoryEntry {
  agent: string
  round: number
  response: string
  toolCalls: ToolCallSummary[]
  hasError: boolean
}

export interface ToolCallSummary {
  toolName: string
  outputPreview: string
}

export type Phase = "active" | "observing" | "done" | "aborted" | "pending"

export interface PluginConfig {
  defaultTimeoutMs: number
  loopSimilarityThreshold: number
  toolOutputPreviewMax: number
  defaultObserverPrompt: string
  maxRounds: number
  navigation: "link" | "selectSession" | "auto" | "none"
}

export interface RoundtableArgs {
  agents?: string[]
  prompt: string
  rounds: number
  observer?: string
  sessionID?: string
  title?: string
  observerPrompt?: string
}

export interface ValidationResult {
  valid: boolean
  available: { name: string; description?: string }[]
  errors: string[]
}
