// index.ts
import { tool } from "@opencode-ai/plugin";

// src/config.ts
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import os from "os";
var configDir = (() => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome)
    return join(xdgConfigHome, "opencode");
  return join(os.homedir(), ".config", "opencode");
})();
var configPath = join(configDir, "roundtable.json");
var configSchemaUrl = "https://raw.githubusercontent.com/RrR2010/opencode-roundtable/refs/heads/master/docs/roundtable.schema.json";
var DEFAULT_CONFIG = {
  defaultTimeoutMs: 300000,
  loopSimilarityThreshold: 0.85,
  toolOutputPreviewMax: 500,
  defaultObserverPrompt: [
    "You are an impartial roundtable observer.",
    "Consolidate the debate above into:",
    "",
    "1. **Executive summary** (2-3 sentences)",
    "2. **Key points** raised by each participant",
    "3. **Decisions or convergences** reached",
    "4. **Remaining open questions**",
    "5. **Suggested next steps**"
  ].join(`
`),
  maxRounds: 10,
  navigation: "link"
};
var config = { ...DEFAULT_CONFIG };
function getConfig() {
  return config;
}
function validateConfig(raw) {
  return {
    defaultTimeoutMs: typeof raw.defaultTimeoutMs === "number" && raw.defaultTimeoutMs >= 30000 ? raw.defaultTimeoutMs : DEFAULT_CONFIG.defaultTimeoutMs,
    loopSimilarityThreshold: typeof raw.loopSimilarityThreshold === "number" && raw.loopSimilarityThreshold >= 0 && raw.loopSimilarityThreshold <= 1 ? raw.loopSimilarityThreshold : DEFAULT_CONFIG.loopSimilarityThreshold,
    toolOutputPreviewMax: typeof raw.toolOutputPreviewMax === "number" && raw.toolOutputPreviewMax >= 100 ? raw.toolOutputPreviewMax : DEFAULT_CONFIG.toolOutputPreviewMax,
    defaultObserverPrompt: typeof raw.defaultObserverPrompt === "string" && raw.defaultObserverPrompt.length > 0 ? raw.defaultObserverPrompt : DEFAULT_CONFIG.defaultObserverPrompt,
    maxRounds: typeof raw.maxRounds === "number" && raw.maxRounds >= 1 ? raw.maxRounds : DEFAULT_CONFIG.maxRounds,
    navigation: raw.navigation === "selectSession" || raw.navigation === "none" || raw.navigation === "auto" ? raw.navigation : DEFAULT_CONFIG.navigation
  };
}
async function loadConfig(ctx) {
  try {
    const content = await readFile(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (typeof raw !== "object" || !raw)
      throw new Error("Invalid config format");
    config = validateConfig(raw);
    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "info",
        message: "Configuration loaded",
        extra: { configPath }
      }
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      try {
        await writeFile(configPath, JSON.stringify({ $schema: configSchemaUrl, ...DEFAULT_CONFIG }, null, 2), "utf-8");
        config = { ...DEFAULT_CONFIG };
        await ctx.client.app.log({
          body: {
            service: "roundtable",
            level: "info",
            message: "Created default configuration",
            extra: { configPath }
          }
        });
      } catch {
        config = { ...DEFAULT_CONFIG };
      }
    } else {
      try {
        await ctx.client.app.log({
          body: {
            service: "roundtable",
            level: "warn",
            message: `Invalid config, using defaults: ${err instanceof Error ? err.message : String(err)}`,
            extra: { configPath }
          }
        });
      } catch {}
      config = { ...DEFAULT_CONFIG };
    }
  }
}

// src/state.ts
import { readFile as readFile2, writeFile as writeFile2, unlink, readdir, mkdir } from "fs/promises";
import { join as join2 } from "path";
import os2 from "os";
var statesDir = (() => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome ? join2(xdgConfigHome, "opencode") : join2(os2.homedir(), ".config", "opencode");
  return join2(base, "roundtable-states");
})();
var states = new Map;
var timeoutHandles = new Map;
var pendingResults = new Map;
var roundtableLocks = new Set;
function stateFilePath(sessionID) {
  return join2(statesDir, `${sessionID}.json`);
}
async function saveStateFile(state) {
  try {
    await mkdir(statesDir, { recursive: true });
  } catch {}
  const filePath = stateFilePath(state.sessionID);
  await writeFile2(filePath, JSON.stringify(state, null, 2), "utf-8");
}
async function loadStateFile(sessionID) {
  try {
    const content = await readFile2(stateFilePath(sessionID), "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || !parsed)
      return null;
    if (typeof parsed.sessionID !== "string")
      return null;
    if (typeof parsed.parentSessionID !== "string")
      return null;
    if (!Array.isArray(parsed.agents))
      return null;
    if (typeof parsed.totalRounds !== "number")
      return null;
    if (typeof parsed.prompt !== "string")
      return null;
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
      lastProcessedMsgId: parsed.lastProcessedMsgId ?? undefined
    };
  } catch {
    return null;
  }
}
async function deleteStateFile(sessionID) {
  try {
    await unlink(stateFilePath(sessionID));
  } catch {}
}
async function listStateFiles() {
  try {
    const entries = await readdir(statesDir);
    return entries.filter((e) => e.endsWith(".json")).map((e) => e.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// src/utils.ts
function generateDefaultTitle(args) {
  if (args.title)
    return args.title;
  const summary = args.prompt.length > 60 ? args.prompt.slice(0, 57) + "..." : args.prompt;
  return `(Roundtable) - ${summary}`;
}
function getSessionIdFromEvent(event) {
  if (!("properties" in event))
    return;
  const props = event.properties;
  if (typeof props.sessionID === "string")
    return props.sessionID;
  if (props.info && typeof props.info === "object") {
    const info = props.info;
    if (info.id)
      return info.id;
  }
  return;
}
async function validateAgents(ctx, agentNames) {
  const errors = [];
  if (agentNames.length < 2) {
    errors.push("At least 2 agents are required");
    return { valid: false, available: [], errors };
  }
  let available = [];
  try {
    const result = await ctx.client.app.agents();
    available = result.data.map((a) => ({
      name: a.name,
      description: a.description
    }));
  } catch {
    errors.push("Failed to fetch available agents from server");
    return { valid: false, available: [], errors };
  }
  const availableNames = new Set(available.map((a) => a.name));
  for (const name of agentNames) {
    if (!availableNames.has(name))
      errors.push(`Agent "${name}" not found`);
  }
  return { valid: errors.length === 0, available, errors };
}
function arraysEqual(a, b) {
  if (a.length !== b.length)
    return false;
  for (let i = 0;i < a.length; i++)
    if (a[i] !== b[i])
      return false;
  return true;
}
function detectLoop(history) {
  if (history.length < 2)
    return false;
  const last = history[history.length - 1].response;
  const prev = history[history.length - 2].response;
  const bigrams = (s) => {
    const set = new Set;
    const cleaned = s.replace(/[\s\n\r]+/g, " ");
    for (let i = 0;i < cleaned.length - 1; i++)
      set.add(cleaned.slice(i, i + 2));
    return set;
  };
  const lastBigrams = bigrams(last);
  const prevBigrams = bigrams(prev);
  let intersection = 0;
  for (const b of lastBigrams)
    if (prevBigrams.has(b))
      intersection++;
  const union = new Set([...lastBigrams, ...prevBigrams]);
  if (union.size === 0)
    return false;
  return intersection / union.size > getConfig().loopSimilarityThreshold;
}
function extractResponse(parts) {
  for (const part of parts)
    if (part.type === "text")
      return part.text;
  return null;
}
function buildToolSummary(part) {
  if (part.type !== "tool")
    return null;
  const toolName = part.tool;
  const state = part.state;
  let outputPreview;
  switch (state.status) {
    case "completed":
      outputPreview = (state.output ?? "(empty)").slice(0, getConfig().toolOutputPreviewMax);
      break;
    case "error":
      outputPreview = (state.output ?? "(unknown error)").slice(0, getConfig().toolOutputPreviewMax);
      break;
    case "running":
    case "pending":
      outputPreview = `(${state.status})`;
      break;
    default:
      outputPreview = "(unknown)";
  }
  return { toolName, outputPreview };
}
function buildToolSummaries(parts) {
  const summaries = [];
  for (const part of parts) {
    const summary = buildToolSummary(part);
    if (summary)
      summaries.push(summary);
  }
  return summaries;
}
function buildConsolidatedSummary(state) {
  const observerEntry = [...state.history].reverse().find((e) => e.agent === "observer");
  if (observerEntry) {
    return observerEntry.response;
  }
  const lines = [];
  lines.push(`━━━ Roundtable ${state.errors.length > 0 ? "Aborted" : "Concluded"} ━━━`);
  lines.push(`Topic: ${state.prompt}`);
  lines.push(`Participants: ${state.agents.join(", ")}`);
  if (state.errors.length > 0)
    lines.push(`Errors: ${state.errors.join("; ")}`);
  return lines.join(`
`);
}
async function injectRoundtableDelimiter(ctx, sessionID) {
  const delimiter = [
    "━━━ Roundtable Concluded ━━━",
    "Messages below this line are not part of the original debate.",
    "The result was consolidated in the main session."
  ].join(`
`);
  await ctx.client.session.prompt({
    path: { id: sessionID },
    body: { noReply: true, parts: [{ type: "text", text: delimiter }] }
  });
}
function buildExtendedPrompt(_originalPrompt, extendPrompt) {
  return `Continue for more rounds. Focus on:
${extendPrompt}`;
}
async function navigateToSession(ctx, targetID, _parentID) {
  try {
    if (typeof ctx.client.tui.selectSession === "function") {
      await ctx.client.tui.selectSession({ sessionID: targetID });
      return true;
    }
    await ctx.client.tui.publish({
      body: {
        type: "tui.session.select",
        properties: { sessionID: targetID }
      }
    });
    return true;
  } catch {
    return false;
  }
}
async function scanOrphanRoundtables(ctx) {
  const sessionIDs = await listStateFiles();
  let loaded = 0;
  let errors = 0;
  for (const sid of sessionIDs) {
    try {
      const state = await loadStateFile(sid);
      if (state) {
        states.set(sid, state);
        loaded++;
      }
    } catch {
      errors++;
    }
  }
  await ctx.client.app.log({
    body: {
      service: "roundtable",
      level: "debug",
      message: `scanOrphanRoundtables: ${loaded} state(s) loaded, ${errors} error(s)`,
      extra: { loaded, errors, total: sessionIDs.length }
    }
  });
}

// src/prompts.ts
function buildAgentPrompt(state, agent) {
  const lines = [];
  const orderStr = state.agents.join(" → ");
  if (state.history.length === 0) {
    lines.push(`Multi-agent discussion — ${state.totalRounds} round(s), ` + `speaking order: ${orderStr}.`, ``, `Topic: ${state.prompt}`, ``);
  }
  lines.push(`--- Round ${state.currentRound + 1} of ${state.totalRounds} — ${agent}'s turn ---`);
  const isLastAgent = state.currentAgentIndex === state.agents.length - 1;
  const isLastRound = state.currentRound === state.totalRounds - 1;
  if (isLastAgent && isLastRound) {
    lines.push("This is the final turn — wrap up your arguments.");
  }
  return lines.join(`
`);
}
function buildObserverPrompt(state, observer) {
  const observerPrompt = state.observerPrompt ?? getConfig().defaultObserverPrompt;
  if (observer === "built-in")
    return observerPrompt;
  return `You are an impartial roundtable observer.
` + `Your role: ${observer}.

` + observerPrompt;
}

// src/handlers.ts
async function startNewRoundtable(ctx, args, toolCtx) {
  const agents = args.agents;
  const newSession = await ctx.client.session.create({
    body: {
      title: generateDefaultTitle({ ...args, agents }),
      parentID: toolCtx.sessionID
    }
  });
  const sessionID = newSession.data.id;
  const parentSessionID = toolCtx.sessionID;
  roundtableLocks.add(sessionID);
  const state = {
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
    observerPrompt: args.observerPrompt
  };
  states.set(sessionID, state);
  try {
    await saveStateFile(state);
    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, sessionID, parentSessionID);
    }
    await sendToAgent(ctx, state);
    await ctx.client.session.prompt({
      path: { id: parentSessionID },
      body: {
        noReply: true,
        parts: [{
          type: "text",
          text: `⚙ Roundtable started — #${sessionID} • ${agents.join(" → ")} • ${args.rounds} round(s)`
        }]
      }
    });
    await ctx.client.tui.showToast({
      body: {
        message: `Roundtable started in #${sessionID} (${agents.join(" → ")} · ${args.rounds} round(s))`,
        variant: "info"
      }
    });
    return sessionID;
  } catch (err) {
    states.delete(sessionID);
    roundtableLocks.delete(sessionID);
    throw err;
  }
}
async function sendToAgent(ctx, state) {
  try {
    const agent = state.agents[state.currentAgentIndex];
    const prompt = buildAgentPrompt(state, agent);
    await ctx.client.session.prompt({
      path: { id: state.sessionID },
      body: { agent, parts: [{ type: "text", text: prompt }] }
    });
    state.currentGeneration++;
    const capturedGeneration = state.currentGeneration;
    const handle = setTimeout(async () => {
      timeoutHandles.delete(state.sessionID);
      if (state.currentGeneration !== capturedGeneration)
        return;
      try {
        await ctx.client.session.abort({ path: { id: state.sessionID } });
        state.errors.push(`Agent "${agent}" timed out after ${getConfig().defaultTimeoutMs / 1000}s`);
      } catch {}
    }, getConfig().defaultTimeoutMs);
    timeoutHandles.set(state.sessionID, handle);
    await updateSessionTitle(ctx, state);
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
          generation: state.currentGeneration
        }
      }
    });
  } catch (err) {
    state.errors.push(`Failed to send to agent "${state.agents[state.currentAgentIndex]}": ${err instanceof Error ? err.message : String(err)}`);
    const handle = timeoutHandles.get(state.sessionID);
    if (handle) {
      clearTimeout(handle);
      timeoutHandles.delete(state.sessionID);
    }
  }
}
async function updateSessionTitle(ctx, state) {
  const summary = state.prompt.length > 40 ? state.prompt.slice(0, 37) + "..." : state.prompt;
  const agentList = state.agents.join("→");
  const roundInfo = `R${state.currentRound + 1}/${state.totalRounds}`;
  const title = `⚡ "${summary}" · ${agentList} (${roundInfo} · ↑ #${state.parentSessionID})`;
  await ctx.client.session.update({
    path: { id: state.sessionID },
    body: { title }
  });
}
async function sendObserverPrompt(ctx, state) {
  try {
    const prompt = buildObserverPrompt(state, state.observer);
    if (state.observer === "built-in") {
      await ctx.client.session.prompt({
        path: { id: state.sessionID },
        body: { noReply: false, parts: [{ type: "text", text: prompt }] }
      });
    } else {
      await ctx.client.session.prompt({
        path: { id: state.sessionID },
        body: { agent: state.observer, parts: [{ type: "text", text: prompt }] }
      });
    }
    await ctx.client.app.log({
      body: {
        service: "roundtable",
        level: "debug",
        message: `Observer prompt sent: ${state.observer}`,
        extra: { sessionID: state.sessionID, observer: state.observer }
      }
    });
  } catch (err) {
    state.errors.push(`Failed to send observer prompt: ${err instanceof Error ? err.message : String(err)}`);
    state.phase = "aborted";
    await finalizeRoundtable(ctx, state);
  }
}
async function finalizeRoundtable(ctx, state) {
  const sessionID = state.sessionID;
  const timeoutHandle = timeoutHandles.get(sessionID);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandles.delete(sessionID);
  }
  try {
    const summary = buildConsolidatedSummary(state);
    const pending = pendingResults.get(sessionID);
    if (pending) {
      pending.resolve(summary);
      pendingResults.delete(sessionID);
    }
    await injectRoundtableDelimiter(ctx, sessionID);
    const shortPrompt = state.prompt.length > 40 ? state.prompt.slice(0, 37) + "..." : state.prompt;
    await ctx.client.session.update({
      path: { id: sessionID },
      body: { title: `⚡ "${shortPrompt}" · ${state.agents.join("→")} ✓` }
    });
    try {
      await saveStateFile(state);
    } catch {}
    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, state.parentSessionID, sessionID);
    }
    await ctx.client.tui.showToast({
      body: { message: "Roundtable concluded", variant: "success" }
    });
  } catch (err) {
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "error",
          message: `Failed to finalize roundtable #${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
          extra: { sessionID, phase: state.phase }
        }
      });
    } catch {}
  } finally {
    states.delete(sessionID);
    roundtableLocks.delete(sessionID);
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: `State cleaned up for session #${sessionID}`,
          extra: { sessionID, phase: state.phase }
        }
      });
    } catch {}
  }
}
async function processNextTurn(ctx, state) {
  if (state.phase === "done" || state.phase === "aborted")
    return;
  const result = await ctx.client.session.messages({ path: { id: state.sessionID } });
  const messages = result.data;
  const assistantMsgs = messages.filter((m) => m.info.role === "assistant");
  if (assistantMsgs.length === 0)
    return;
  const latestMsg = assistantMsgs[assistantMsgs.length - 1];
  if (state.lastProcessedMsgId === latestMsg.info.id)
    return;
  state.lastProcessedMsgId = latestMsg.info.id;
  if (state.phase === "active") {
    const response = extractResponse(latestMsg.parts);
    if (!response) {
      state.errors.push(`Agent ${state.agents[state.currentAgentIndex]} returned no text in round ${state.currentRound + 1}`);
    }
    const toolCalls = buildToolSummaries(latestMsg.parts);
    const entry = {
      agent: state.agents[state.currentAgentIndex],
      round: state.currentRound,
      response: response ?? "(no text response)",
      toolCalls,
      hasError: response === null
    };
    state.history.push(entry);
    await saveStateFile(state);
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
          hasError: entry.hasError
        }
      }
    });
    if (detectLoop(state.history)) {
      state.errors.push("Loop detected — agents reached an impasse");
      state.phase = "done";
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Loop detected — finalizing early",
          extra: { sessionID: state.sessionID, similarity: getConfig().loopSimilarityThreshold }
        }
      });
      await finalizeRoundtable(ctx, state);
      return;
    }
    const nextIndex = state.currentAgentIndex + 1;
    if (nextIndex < state.agents.length) {
      state.currentAgentIndex = nextIndex;
      await sendToAgent(ctx, state);
    } else if (state.currentRound + 1 < state.totalRounds) {
      state.currentRound++;
      state.currentAgentIndex = 0;
      await sendToAgent(ctx, state);
    } else {
      state.phase = "observing";
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "All rounds complete — transitioning to observer",
          extra: { sessionID: state.sessionID, totalRounds: state.totalRounds }
        }
      });
      await sendObserverPrompt(ctx, state);
    }
    return;
  }
  if (state.phase === "observing") {
    const summary = extractResponse(latestMsg.parts);
    state.history.push({
      agent: "observer",
      round: state.currentRound,
      response: summary ?? "(no summary)",
      toolCalls: [],
      hasError: summary === null
    });
    await saveStateFile(state);
    state.phase = "done";
    await finalizeRoundtable(ctx, state);
  }
}
async function handleAgentError(ctx, state, event) {
  if (state.phase === "observing" || state.phase === "done") {
    state.phase = "aborted";
    await saveStateFile(state);
    await finalizeRoundtable(ctx, state);
    return;
  }
  const agent = state.agents[state.currentAgentIndex];
  const errorMsg = event.type === "session.error" && event.properties.error ? typeof event.properties.error === "object" ? event.properties.error.message ?? JSON.stringify(event.properties.error) : String(event.properties.error) : "Unknown error";
  state.errors.push(`Agent "${agent}" failed on round ${state.currentRound + 1}: ${errorMsg}`);
  const handle = timeoutHandles.get(state.sessionID);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(state.sessionID);
  }
  await ctx.client.tui.showToast({
    body: {
      message: `"${agent}" failed on Round ${state.currentRound + 1}. Skipping to next.`,
      variant: "warning"
    }
  });
  const nextIndex = state.currentAgentIndex + 1;
  if (nextIndex < state.agents.length) {
    state.currentAgentIndex = nextIndex;
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Agent skipped due to error",
          extra: { sessionID: state.sessionID, failedAgent: agent, nextAgent: state.agents[state.currentAgentIndex], round: state.currentRound + 1 }
        }
      });
    } catch {}
    await saveStateFile(state);
    await sendToAgent(ctx, state);
  } else if (state.currentRound + 1 < state.totalRounds) {
    state.currentRound++;
    state.currentAgentIndex = 0;
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "Agent skipped due to error — moving to next round",
          extra: { sessionID: state.sessionID, failedAgent: agent, round: state.currentRound + 1 }
        }
      });
    } catch {}
    await saveStateFile(state);
    await sendToAgent(ctx, state);
  } else {
    state.phase = "aborted";
    try {
      await ctx.client.tui.showToast({
        body: { message: "All agents failed — roundtable aborted", variant: "error" }
      });
    } catch {}
    await saveStateFile(state);
    await finalizeRoundtable(ctx, state);
  }
}
async function handleSessionDeleted(ctx, state, deletedSessionID) {
  const handle = timeoutHandles.get(state.sessionID);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(state.sessionID);
  }
  await deleteStateFile(state.sessionID);
  if (deletedSessionID === state.sessionID) {
    state.phase = "aborted";
    const partialSummary = buildConsolidatedSummary(state);
    const output = [
      "[Roundtable interrupted — session closed]",
      "Partial history up to interruption:",
      "",
      partialSummary
    ].join(`
`);
    const pending = pendingResults.get(state.sessionID);
    if (pending) {
      pending.resolve(output);
      pendingResults.delete(state.sessionID);
    }
    try {
      await ctx.client.tui.showToast({
        body: { message: "Roundtable interrupted", variant: "warning" }
      });
    } catch {}
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "S2 deleted — pending promise resolved with partial result",
          extra: { sessionID: deletedSessionID, parentSessionID: state.parentSessionID }
        }
      });
    } catch {}
  } else if (deletedSessionID === state.parentSessionID) {
    state.phase = "aborted";
    try {
      await ctx.client.session.abort({ path: { id: state.sessionID } });
    } catch {}
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "debug",
          message: "S1 deleted — S2 aborted",
          extra: { sessionID: state.sessionID, parentSessionID: deletedSessionID }
        }
      });
    } catch {}
  }
  states.delete(state.sessionID);
}
async function extendRoundtable(ctx, args, _toolCtx) {
  const sessionID = args.sessionID;
  try {
    await ctx.client.session.get({ path: { id: sessionID } });
  } catch {
    return `Error: Session #${sessionID} not found or inaccessible. Cannot extend.`;
  }
  const originalState = await loadStateFile(sessionID);
  if (!originalState) {
    return [
      `Error: No roundtable state found for session #${sessionID}.`,
      "This session is not a roundtable or the state file was deleted."
    ].join(`
`);
  }
  if (originalState.phase !== "done") {
    return [
      `Error: Roundtable #${sessionID} is in state "${originalState.phase}" and cannot be extended.`
    ].join(`
`);
  }
  if (args.agents && !arraysEqual(args.agents, originalState.agents)) {
    return [
      "Error: Agent mismatch.",
      `Original: ${originalState.agents.join(", ")}`,
      `Provided: ${args.agents.join(", ")}`,
      "Extend must use the same agents as the original roundtable."
    ].join(`
`);
  }
  try {
    const storedValidation = await validateAgents(ctx, originalState.agents);
    if (!storedValidation.valid) {
      return [
        "Error: One or more agents from the original roundtable no longer exist.",
        ...storedValidation.errors.map((e) => `  - ${e}`)
      ].join(`
`);
    }
  } catch {
    return "Error: Failed to validate agents. Cannot extend.";
  }
  const extendedPrompt = buildExtendedPrompt(originalState.prompt, args.prompt);
  const newState = {
    sessionID: originalState.sessionID,
    parentSessionID: originalState.parentSessionID,
    agents: originalState.agents,
    totalRounds: args.rounds,
    observer: originalState.observer,
    prompt: extendedPrompt,
    currentRound: 0,
    currentAgentIndex: 0,
    phase: "active",
    history: [...originalState.history],
    errors: [...originalState.errors],
    createdAt: Date.now(),
    currentGeneration: 0,
    observerPrompt: args.observerPrompt ?? originalState.observerPrompt
  };
  states.set(sessionID, newState);
  try {
    await saveStateFile(newState);
    if (getConfig().navigation === "auto") {
      await navigateToSession(ctx, sessionID, originalState.parentSessionID);
    }
    const agentList = originalState.agents.join(" vs ");
    await ctx.client.session.update({
      path: { id: sessionID },
      body: { title: `Roundtable: ${agentList} (R${newState.currentRound + 1}/${newState.totalRounds})` }
    });
    await ctx.client.session.prompt({
      path: { id: originalState.parentSessionID },
      body: {
        noReply: true,
        parts: [{
          type: "text",
          text: `⚙ Roundtable extended — #${sessionID} • +${args.rounds} round(s)`
        }]
      }
    });
    await sendToAgent(ctx, newState);
    await ctx.client.tui.showToast({
      body: {
        message: `Roundtable #${sessionID} extended — ${args.rounds} more round(s) (${originalState.agents.join(" → ")})`,
        variant: "info"
      }
    });
    return sessionID;
  } catch (err) {
    states.delete(sessionID);
    throw err;
  }
}

// index.ts
var RoundtablePlugin = async (ctx) => {
  try {
    await ctx.client.app.log({
      body: { service: "roundtable", level: "debug", message: "PLUGIN_LOADED" }
    });
  } catch {}
  try {
    await loadConfig(ctx);
  } catch {}
  try {
    await scanOrphanRoundtables(ctx);
  } catch (err) {
    try {
      await ctx.client.app.log({
        body: {
          service: "roundtable",
          level: "error",
          message: `scanOrphanRoundtables failed: ${err instanceof Error ? err.message : String(err)}`
        }
      });
    } catch {}
  }
  return {
    event: async ({ event }) => {
      const sessionID = getSessionIdFromEvent(event);
      if (!sessionID || !states.has(sessionID))
        return;
      const state = states.get(sessionID);
      switch (event.type) {
        case "session.idle": {
          const handle = timeoutHandles.get(sessionID);
          if (handle) {
            clearTimeout(handle);
            timeoutHandles.delete(sessionID);
          }
          await processNextTurn(ctx, state);
          break;
        }
        case "session.error": {
          await handleAgentError(ctx, state, event);
          break;
        }
        case "session.deleted": {
          const deletedID = event.properties.info?.id;
          if (deletedID)
            await handleSessionDeleted(ctx, state, deletedID);
          break;
        }
      }
    },
    "experimental.session.compacting": async (_input, _output) => {},
    tool: {
      roundtable: tool({
        description: "Starts a multi-agent roundtable debate where agents discuss a topic turn by turn. " + `After all rounds, a built-in observer consolidates the discussion into an executive summary.

` + `Returns an object with { sessionID, summary } after the debate concludes.

` + "Note: this tool injects system-level prompts into each agent's context during " + `the debate (role-setting, topic, turn routing, and lifecycle signals).

` + "IMPORTANT: This tool requires 2+ agents. For single-agent tasks, use a regular " + `session prompt instead — do NOT use roundtable.

` + "Choosing agents: select agents based on their expertise (e.g., pm for product decisions, " + "dev for technical trade-offs, rv for code review). You can also specify in the prompt " + `what each agent should focus on (e.g., 'pm: focus on cost; dev: focus on maintainability').

` + "Multiple rounds: for complex topics, use 2+ rounds and INCLUDE per-round focus " + "instructions IN the prompt itself (e.g., prompt: 'Round 1: list pros. Round 2: " + "list cons. Round 3: propose an implementation plan'). This way all agents see " + "the full agenda. The default is 1 round.",
        args: {
          agents: tool.schema.array(tool.schema.string()).min(2).describe("Agent names in speaking order (minimum 2). For single-agent tasks, use a regular " + "session — do NOT use roundtable. Choose agents based on their expertise and " + "think about the logical sequence: who should speak first to set context, " + "who should react next, who should close. " + 'Example: ["pm", "dev", "rv"] means pm speaks first, then dev, then rv.'),
          prompt: tool.schema.string().describe("Topic or challenge for the agents to debate. For multi-round debates, " + "include per-round instructions here (e.g., 'Round 1: pros. Round 2: cons. " + "Round 3: plan.'). All agents will see this and follow the round structure."),
          rounds: tool.schema.number().min(1).max(50).describe("Number of complete rounds (each round = all agents speak once). " + "Default: 1. Max: 50. For complex topics with 2+ rounds, include per-round focus " + "instructions in the prompt parameter so all agents see the agenda."),
          observer: tool.schema.string().describe("Agent name for final consolidation. The observer does not debate — it " + "summarizes after all rounds. Omit to use the built-in observer."),
          sessionID: tool.schema.string().describe("Session ID (format: ses_xxxx) from a previous roundtable call to " + "continue a concluded debate. Prefer extend over starting a new " + "roundtable — it reuses accumulated context, saving exploration tokens. " + "Omit this parameter and pass agents + prompt to start a fresh debate."),
          title: tool.schema.string().describe("Custom title for the session (max 200 chars). If omitted, auto-generated " + 'as "(Roundtable) - {first 80 chars of prompt, truncated at word boundary}".'),
          observerPrompt: tool.schema.string().describe("Override the default observer consolidation prompt. Use this to control " + "the format and focus of the final summary — e.g., ask the observer to " + "save a detailed report to file, focus on technical decisions only, " + "output as JSON, extract action items, etc. " + "If omitted, the default observer prompt is used (executive summary).")
        },
        async execute(args, toolCtx) {
          try {
            if (states.has(toolCtx.sessionID)) {
              return `Cannot nest roundtables. You are already inside roundtable #${toolCtx.sessionID}. Wait for it to complete before starting another.`;
            }
            const rounds = args.rounds ?? 1;
            if (args.sessionID && typeof args.sessionID === "string" && args.sessionID.trim()) {
              if (args.agents)
                return "Error: pass either sessionID or agents, not both";
              const sid2 = await extendRoundtable(ctx, args, toolCtx);
              if (sid2.startsWith("Error:") || sid2.startsWith("Invalid"))
                return sid2;
              toolCtx.metadata({ title: "Roundtable (extended)", metadata: { sessionId: sid2 } });
              const result2 = await new Promise((resolve) => pendingResults.set(sid2, { resolve }));
              return result2;
            }
            if (!args.agents || !Array.isArray(args.agents) || args.agents.length < 2) {
              return "Error: 'agents' with at least 2 names is required";
            }
            const validation = await validateAgents(ctx, args.agents);
            if (!validation.valid) {
              const avail = validation.available.map((a) => a.name).join(", ");
              return ["Invalid agent configuration:", ...validation.errors.map((e) => `  - ${e}`), `Available agents: ${avail}`].join(`
`);
            }
            if (rounds > 50)
              return "Error: Maximum 50 rounds allowed";
            const sid = await startNewRoundtable(ctx, { ...args, rounds }, toolCtx);
            toolCtx.metadata({ title: `Roundtable: ${args.agents?.join(" → ")}`, metadata: { sessionId: sid } });
            const result = await new Promise((resolve) => pendingResults.set(sid, { resolve }));
            return result;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }),
      available_agents: tool({
        description: "Lists all configured agents and their roles. " + 'Returns a formatted list of agent names (e.g., "Available agents: pm, dev, rv"). ' + "Use this to choose which agents should participate in a roundtable " + "based on their descriptions — then call roundtable() with your selection.",
        args: {},
        async execute() {
          try {
            const result = await ctx.client.app.agents();
            const names = result.data.map((a) => a.name);
            return `Available agents: ${names.join(", ")}`;
          } catch {
            return "Error: Could not fetch agent list. The server might not be ready.";
          }
        }
      }),
      active_roundtables: tool({
        description: "Lists all active roundtables with their status. " + "Each entry shows session ID, agents, current round, and phase. " + "Returns clickable session IDs that can be used to navigate.",
        args: {},
        async execute() {
          const active = [];
          for (const [sid, s] of states) {
            const status = s.phase === "active" ? "debating" : s.phase === "observing" ? "consolidating" : s.phase === "done" ? "concluded" : s.phase;
            active.push(`- #${sid} · ${s.agents.join("→")} (R${s.currentRound + 1}/${s.totalRounds}) · ${status}`);
          }
          if (active.length === 0)
            return "No active roundtables.";
          return `Active roundtables:
${active.join(`
`)}`;
        }
      })
    }
  };
};
export {
  RoundtablePlugin
};

//# debugId=78271419B44F611C64756E2164756E21
//# sourceMappingURL=index.js.map
