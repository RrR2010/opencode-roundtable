import { readFile, writeFile } from "fs/promises"
import { join } from "path"
import os from "os"
import type { PluginConfig } from "./types"
import type { PluginInput } from "@opencode-ai/plugin"

const configDir = (() => {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) return join(xdgConfigHome, "opencode")
  return join(os.homedir(), ".config", "opencode")
})()

const configPath = join(configDir, "roundtable.json")

const configSchemaUrl =
  "https://raw.githubusercontent.com/RrR2010/opencode-roundtable/refs/heads/master/docs/roundtable.schema.json"

const DEFAULT_CONFIG: PluginConfig = {
  defaultTimeoutMs: 300_000,
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
    "5. **Suggested next steps**",
  ].join("\n"),
  maxRounds: 10,
  navigation: "link",
}

let config: PluginConfig = { ...DEFAULT_CONFIG }

export function getConfig(): PluginConfig {
  return config
}

function validateConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    defaultTimeoutMs:
      typeof raw.defaultTimeoutMs === "number" && raw.defaultTimeoutMs >= 30_000
        ? raw.defaultTimeoutMs
        : DEFAULT_CONFIG.defaultTimeoutMs,
    loopSimilarityThreshold:
      typeof raw.loopSimilarityThreshold === "number" &&
      raw.loopSimilarityThreshold >= 0 &&
      raw.loopSimilarityThreshold <= 1
        ? raw.loopSimilarityThreshold
        : DEFAULT_CONFIG.loopSimilarityThreshold,
    toolOutputPreviewMax:
      typeof raw.toolOutputPreviewMax === "number" && raw.toolOutputPreviewMax >= 100
        ? raw.toolOutputPreviewMax
        : DEFAULT_CONFIG.toolOutputPreviewMax,
    defaultObserverPrompt:
      typeof raw.defaultObserverPrompt === "string" && raw.defaultObserverPrompt.length > 0
        ? raw.defaultObserverPrompt
        : DEFAULT_CONFIG.defaultObserverPrompt,
    maxRounds:
      typeof raw.maxRounds === "number" && raw.maxRounds >= 1
        ? raw.maxRounds
        : DEFAULT_CONFIG.maxRounds,
    navigation:
      raw.navigation === "selectSession" || raw.navigation === "none" || raw.navigation === "auto"
        ? raw.navigation
        : DEFAULT_CONFIG.navigation,
  }
}

export async function loadConfig(ctx: PluginInput): Promise<void> {
  try {
    const content = await readFile(configPath, "utf-8")
    const raw = JSON.parse(content)
    if (typeof raw !== "object" || !raw) throw new Error("Invalid config format")
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
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      try {
        await writeFile(
          configPath,
          JSON.stringify({ $schema: configSchemaUrl, ...DEFAULT_CONFIG }, null, 2),
          "utf-8",
        )
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
        config = { ...DEFAULT_CONFIG }
      }
    } else {
      try {
        await ctx.client.app.log({
          body: {
            service: "roundtable",
            level: "warn",
            message: `Invalid config, using defaults: ${err instanceof Error ? err.message : String(err)}`,
            extra: { configPath },
          },
        })
      } catch { /* best-effort */ }
      config = { ...DEFAULT_CONFIG }
    }
  }
}
