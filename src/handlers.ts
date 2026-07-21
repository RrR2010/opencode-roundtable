import type { PluginInput } from "@opencode-ai/plugin"
import type { RoundtableArgs, RoundtableState, HistoryEntry, Event as RoundtableEvent } from "./types"
import { states, timeoutHandles, pendingResults, saveStateFile, loadStateFile, deleteStateFile } from "./state"
import { getConfig } from "./config"
import { buildAgentPrompt, buildObserverPrompt } from "./prompts"
import {
  validateAgents, arraysEqual, buildExtendedPrompt, detectLoop,
  extractResponse, buildToolSummaries, buildConsolidatedSummary,
  generateDefaultTitle, injectRoundtableDelimiter, scanOrphanRoundtables,
  navigateToSession,
} from "./utils"

// ============================================================
// startNewRoundtable
// ============================================================

export async function startNewRoundtable(
  ctx: PluginInput,
  args: RoundtableArgs,
  toolCtx: { sessionID: string },
): Promise<string> {
  const agents = args.agents!
  const newSession = await ctx.client.session.create({
    body: {
      title: generateDefaultTitle({ ...args, agents }),
      parentID: toolCtx.sessionID,
    },
  })

  const sessionID = newSession.data.id
  const parentSessionID = toolCtx.sessionID

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
    observerPrompt: args.observerPrompt,
  }

  states.set(sessionID, state)

  try {
    await saveStateFile(state)

    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, sessionID, parentSessionID)
    }

    await sendToAgent(ctx, state)

    await ctx.client.session.prompt({
      path: { id: parentSessionID },
      body: {
        noReply: true,
        parts: [{
          type: "text",
          text: `⚙ Roundtable started — #${sessionID} • ${agents.join(" → ")} • ${args.rounds} round(s)`,
        }],
      },
    })

    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text: `⚙ Parent: #${parentSessionID}` }],
      },
    })

    await ctx.client.tui.showToast({
      body: {
        message: `Roundtable started in #${sessionID} (${agents.join(" → ")} · ${args.rounds} round(s))`,
        variant: "info",
      },
    })

    return sessionID
  } catch (err) {
    states.delete(sessionID)
    throw err
  }
}

// ============================================================
// sendToAgent
// ============================================================

export async function sendToAgent(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  try {
    const agent = state.agents[state.currentAgentIndex]
    const prompt = buildAgentPrompt(state, agent)

    await ctx.client.session.prompt({
      path: { id: state.sessionID },
      body: { agent, parts: [{ type: "text", text: prompt }] },
    })

    state.currentGeneration++
    const capturedGeneration = state.currentGeneration

    const handle = setTimeout(async () => {
      timeoutHandles.delete(state.sessionID)
      if (state.currentGeneration !== capturedGeneration) return

      try {
        await ctx.client.session.abort({ path: { id: state.sessionID } })
        state.errors.push(`Agent "${agent}" timed out after ${getConfig().defaultTimeoutMs / 1000}s`)
      } catch { /* session may already be done */ }
    }, getConfig().defaultTimeoutMs)

    timeoutHandles.set(state.sessionID, handle)
    await updateSessionTitle(ctx, state)

    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Turn started: ${agent} (R${state.currentRound + 1}/${state.totalRounds})`,
        extra: {
          sessionID: state.sessionID, agent,
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
    if (handle) { clearTimeout(handle); timeoutHandles.delete(state.sessionID) }
  }
}

// ============================================================
// updateSessionTitle
// ============================================================

export async function updateSessionTitle(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const summary = state.prompt.length > 40 ? state.prompt.slice(0, 37) + "..." : state.prompt
  const agentList = state.agents.join("→")
  const roundInfo = `R${state.currentRound + 1}/${state.totalRounds}`
  const title = `⚡ "${summary}" · ${agentList} (${roundInfo} · ↑ #${state.parentSessionID})`
  await ctx.client.session.update({
    path: { id: state.sessionID },
    body: { title },
  })
}

// ============================================================
// sendObserverPrompt
// ============================================================

async function sendObserverPrompt(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  try {
    const prompt = buildObserverPrompt(state, state.observer)

    if (state.observer === "built-in") {
      await ctx.client.session.prompt({
        path: { id: state.sessionID },
        body: { noReply: false, parts: [{ type: "text", text: prompt }] },
      })
    } else {
      await ctx.client.session.prompt({
        path: { id: state.sessionID },
        body: { agent: state.observer, parts: [{ type: "text", text: prompt }] },
      })
    }

    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Observer prompt sent: ${state.observer}`,
        extra: { sessionID: state.sessionID, observer: state.observer },
      },
    })
  } catch (err) {
    state.errors.push(`Failed to send observer prompt: ${err instanceof Error ? err.message : String(err)}`)
    state.phase = "aborted"
    await finalizeRoundtable(ctx, state)
  }
}

// ============================================================
// finalizeRoundtable
// ============================================================

export async function finalizeRoundtable(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  const sessionID = state.sessionID

  const timeoutHandle = timeoutHandles.get(sessionID)
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandles.delete(sessionID) }

  try {
    const summary = buildConsolidatedSummary(state)

    const pending = pendingResults.get(sessionID)
    if (pending) {
      pending.resolve(summary)
      pendingResults.delete(sessionID)
    }

    await injectRoundtableDelimiter(ctx, sessionID)

    const shortPrompt = state.prompt.length > 40 ? state.prompt.slice(0, 37) + "..." : state.prompt
    await ctx.client.session.update({
      path: { id: sessionID },
      body: { title: `⚡ "${shortPrompt}" · ${state.agents.join("→")} ✓` },
    })

    try {
      await saveStateFile(state)
    } catch { /* best-effort */ }

    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, state.parentSessionID, sessionID)
    }

    await ctx.client.tui.showToast({
      body: { message: "Roundtable concluded", variant: "success" },
    })
  } catch (err) {
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "error",
          message: `Failed to finalize roundtable #${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
          extra: { sessionID, phase: state.phase },
        },
      })
    } catch { /* best-effort */ }
  } finally {
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
    } catch { /* best-effort */ }
  }
}

// ============================================================
// processNextTurn
// ============================================================

export async function processNextTurn(
  ctx: PluginInput,
  state: RoundtableState,
): Promise<void> {
  if (state.phase === "done" || state.phase === "aborted") return

  const result = await ctx.client.session.messages({ path: { id: state.sessionID } })
  const messages = result.data

  const userMsgs = messages.filter((m: { info: { role: string } }) => m.info.role === "user")
  for (const msg of userMsgs) {
    for (const part of msg.parts) {
      if (part.type === "text") {
        if (!state.userInterjections.includes(part.text)) {
          state.userInterjections.push(part.text)
        }
      }
    }
  }

  const assistantMsgs = messages.filter(
    (m: { info: { role: string } }) => m.info.role === "assistant",
  )
  if (assistantMsgs.length === 0) return

  const latestMsg = assistantMsgs[assistantMsgs.length - 1]
  if (state.lastProcessedMsgId === latestMsg.info.id) return
  state.lastProcessedMsgId = latestMsg.info.id

  if (state.phase === "active") {
    const response = extractResponse(latestMsg.parts)
    if (!response) {
      state.errors.push(
        `Agent ${state.agents[state.currentAgentIndex]} returned no text in round ${state.currentRound + 1}`,
      )
    }

    const toolCalls = buildToolSummaries(latestMsg.parts)
    const entry: HistoryEntry = {
      agent: state.agents[state.currentAgentIndex],
      round: state.currentRound,
      response: response ?? "(no text response)",
      toolCalls,
      hasError: response === null,
    }
    state.history.push(entry)
    await saveStateFile(state)

    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Turn complete: ${entry.agent} (R${state.currentRound + 1})`,
        extra: {
          sessionID: state.sessionID, agent: entry.agent,
          round: state.currentRound + 1,
          responseLength: entry.response.length,
          toolCallCount: entry.toolCalls.length,
          hasError: entry.hasError,
        },
      },
    })

    if (detectLoop(state.history)) {
      state.errors.push("Loop detected — agents reached an impasse")
      state.phase = "done"
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Loop detected — finalizing early",
          extra: { sessionID: state.sessionID, similarity: getConfig().loopSimilarityThreshold },
        },
      })
      await finalizeRoundtable(ctx, state)
      return
    }

    const nextIndex = state.currentAgentIndex + 1
    if (nextIndex < state.agents.length) {
      state.currentAgentIndex = nextIndex
      await sendToAgent(ctx, state)
    } else if (state.currentRound + 1 < state.totalRounds) {
      state.currentRound++
      state.currentAgentIndex = 0
      await sendToAgent(ctx, state)
    } else {
      state.phase = "observing"
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "All rounds complete — transitioning to observer",
          extra: { sessionID: state.sessionID, totalRounds: state.totalRounds },
        },
      })
      await sendObserverPrompt(ctx, state)
    }
    return
  }

  if (state.phase === "observing") {
    const summary = extractResponse(latestMsg.parts)
    state.history.push({
      agent: "observer",
      round: state.currentRound,
      response: summary ?? "(no summary)",
      toolCalls: [],
      hasError: summary === null,
    })
    await saveStateFile(state)

    state.phase = "done"
    await finalizeRoundtable(ctx, state)
  }
}

// ============================================================
// handleAgentError
// ============================================================

export async function handleAgentError(
  ctx: PluginInput,
  state: RoundtableState,
  event: RoundtableEvent,
): Promise<void> {
  if (state.phase === "observing" || state.phase === "done") {
    state.phase = "aborted"
    await saveStateFile(state)
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

  const handle = timeoutHandles.get(state.sessionID)
  if (handle) { clearTimeout(handle); timeoutHandles.delete(state.sessionID) }

  await ctx.client.tui.showToast({
    body: {
      message: `"${agent}" failed on Round ${state.currentRound + 1}. Skipping to next.`,
      variant: "warning",
    },
  })

  const nextIndex = state.currentAgentIndex + 1
  if (nextIndex < state.agents.length) {
    state.currentAgentIndex = nextIndex
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Agent skipped due to error",
          extra: { sessionID: state.sessionID, failedAgent: agent, nextAgent: state.agents[state.currentAgentIndex], round: state.currentRound + 1 },
        },
      })
    } catch { /* best-effort */ }
    await saveStateFile(state)
    await sendToAgent(ctx, state)
  } else if (state.currentRound + 1 < state.totalRounds) {
    state.currentRound++
    state.currentAgentIndex = 0
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Agent skipped due to error — moving to next round",
          extra: { sessionID: state.sessionID, failedAgent: agent, round: state.currentRound + 1 },
        },
      })
    } catch { /* best-effort */ }
    await saveStateFile(state)
    await sendToAgent(ctx, state)
  } else {
    state.phase = "aborted"
    try {
      await ctx.client.tui.showToast({
        body: { message: "All agents failed — roundtable aborted", variant: "error" },
      })
    } catch { /* best-effort */ }
    await saveStateFile(state)
    await finalizeRoundtable(ctx, state)
  }
}

// ============================================================
// handleSessionDeleted
// ============================================================

export async function handleSessionDeleted(
  ctx: PluginInput,
  state: RoundtableState,
  deletedSessionID: string,
): Promise<void> {
  const handle = timeoutHandles.get(state.sessionID)
  if (handle) { clearTimeout(handle); timeoutHandles.delete(state.sessionID) }

  await deleteStateFile(state.sessionID)

  if (deletedSessionID === state.sessionID) {
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
        body: { message: "Roundtable interrupted", variant: "warning" },
      })
    } catch { /* best-effort */ }
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "S2 deleted — pending promise resolved with partial result",
          extra: { sessionID: deletedSessionID, parentSessionID: state.parentSessionID },
        },
      })
    } catch { /* best-effort */ }
  } else if (deletedSessionID === state.parentSessionID) {
    state.phase = "aborted"
    try {
      await ctx.client.session.abort({ path: { id: state.sessionID } })
    } catch { /* S2 may already be gone */ }
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "S1 deleted — S2 aborted",
          extra: { sessionID: state.sessionID, parentSessionID: deletedSessionID },
        },
      })
    } catch { /* best-effort */ }
  }

  states.delete(state.sessionID)
}

// ============================================================
// extendRoundtable
// ============================================================

export async function extendRoundtable(
  ctx: PluginInput,
  args: RoundtableArgs,
  _toolCtx: { sessionID: string },
): Promise<string> {
  const sessionID = args.sessionID!

  try {
    await ctx.client.session.get({ path: { id: sessionID } })
  } catch {
    return `Error: Session #${sessionID} not found or inaccessible. Cannot extend.`
  }

  const originalState = await loadStateFile(sessionID)
  if (!originalState) {
    return [
      `Error: No roundtable state found for session #${sessionID}.`,
      "This session is not a roundtable or the state file was deleted.",
    ].join("\n")
  }

  if (originalState.phase !== "done") {
    return [
      `Error: Roundtable #${sessionID} is in state "${originalState.phase}" and cannot be extended.`,
    ].join("\n")
  }

  if (args.agents && !arraysEqual(args.agents, originalState.agents)) {
    return [
      "Error: Agent mismatch.",
      `Original: ${originalState.agents.join(", ")}`,
      `Provided: ${args.agents.join(", ")}`,
      "Extend must use the same agents as the original roundtable.",
    ].join("\n")
  }

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

  const extendedPrompt = buildExtendedPrompt(originalState.prompt, args.prompt)

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
    observerPrompt: args.observerPrompt ?? originalState.observerPrompt,
  }

  states.set(sessionID, newState)

  try {
    await saveStateFile(newState)

    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, sessionID, originalState.parentSessionID)
    }

    const agentList = originalState.agents.join(" vs ")
    await ctx.client.session.update({
      path: { id: sessionID },
      body: { title: `Roundtable: ${agentList} (R${newState.currentRound + 1}/${newState.totalRounds})` },
    })

    await ctx.client.session.prompt({
      path: { id: originalState.parentSessionID },
      body: {
        noReply: true,
        parts: [{
          type: "text",
          text: `⚙ Roundtable extended — #${sessionID} • +${args.rounds} round(s)`,
        }],
      },
    })

    await sendToAgent(ctx, newState)

    await ctx.client.tui.showToast({
      body: {
        message: `Roundtable #${sessionID} extended — ${args.rounds} more round(s) (${originalState.agents.join(" → ")})`,
        variant: "info",
      },
    })

    return sessionID
  } catch (err) {
    states.delete(sessionID)
    throw err
  }
}
