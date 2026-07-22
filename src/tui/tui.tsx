/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

let api: TuiPluginApi

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
