/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { registerTool } from "@opencode-ai/session-ui/message-part"
import { BasicTool } from "@opencode-ai/session-ui/basic-tool"

let api: TuiPluginApi

registerTool({
  name: "roundtable",
  render(props) {
    const sessionId = () => props.metadata?.sessionId as string | undefined
    const running = () => props.status === "pending" || props.status === "running"
    const input = () => (props.input ?? {}) as Record<string, unknown>
    const agents = () => (input().agents ?? []) as string[]
    const prompt = () => (input().prompt ?? "") as string
    const title = () => props.metadata?.title as string | undefined
    const label = () => title() ?? "Roundtable"

    return (
      <BasicTool
        icon="mcp"
        status={props.status}
        trigger={
          running()
            ? () => (
                <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                  <span style={{ color: "var(--accent)" }}>●</span>
                  <span>{label()} — {agents().join(" → ")} · R{input().rounds ?? "?"}</span>
                </div>
              )
            : {
                title: label(),
                subtitle: prompt().slice(0, 80),
                args: [`${agents().join("→")} · ${input().rounds ?? "?"} round(s)`],
              }
        }
        triggerHref={sessionId() ? `/session/${sessionId()}` : undefined}
        triggerAsLink={!!sessionId()}
        clickable={!!sessionId()}
        onTriggerClick={() => {
          const id = sessionId()
          if (id) api?.route.navigate("session", { sessionID: id })
        }}
      >
        <pre style={{ "white-space": "pre-wrap", margin: 0 }}>{props.output}</pre>
      </BasicTool>
    )
  },
})

async function showRoundtables() {
  try {
    const res = await api.client.session.list()
    const sessions = res.data ?? []
    const rts = sessions.filter((s: { title?: string }) => s.title?.startsWith("⚡"))
    if (rts.length === 0) {
      api.ui.toast({ message: "No active roundtables", variant: "info" })
      return
    }

    api.ui.dialog.replace(() => (
      <box padding={1} flexDirection="column">
        <text bold>Roundtables</text>
        {rts.map((s: { id: string; title: string }) => (
          <box
            flexDirection="row"
            paddingTop={1}
            onMouseUp={() => {
              api.ui.dialog.clear()
              api.route.navigate("session", { sessionID: s.id })
            }}
          >
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={api.theme.current.backgroundElement}
            >
              <text>→</text>
            </box>
            <box paddingLeft={1}>
              <text>{s.title.replace(/^⚡ /, "")}</text>
            </box>
          </box>
        ))}
      </box>
    ))
  } catch {
    api.ui.toast({ message: "Could not list sessions", variant: "error" })
  }
}

const tui: TuiPluginModule["tui"] = async (a) => {
  api = a

  api.command?.register(() => [
    {
      title: "Roundtables",
      value: "roundtables.list",
      description: "List active roundtable sessions",
      slash: { name: "roundtables" },
      onSelect: () => showRoundtables(),
    },
  ])
}

export default {
  id: "opencode-roundtable",
  tui,
} satisfies TuiPluginModule
