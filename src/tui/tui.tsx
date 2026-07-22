/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

let api: TuiPluginApi

function currentSessionID(): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  return route.params?.sessionID as string | undefined
}

function parseParentID(title: string): string | undefined {
  const m = title.match(/↑ #(\S+)/)
  return m ? m[1] : undefined
}

async function showRoundtables() {
  try {
    const currentID = currentSessionID()
    const res = await api.client.session.list()
    const sessions = res.data ?? []
    const allRts = sessions.filter((s: { title?: string }) => s.title?.startsWith("⚡"))

    if (allRts.length === 0) {
      api.ui.toast({ message: "No active roundtables", variant: "info" })
      return
    }

    const rts = currentID
      ? allRts.filter((s: { title: string }) => parseParentID(s.title) === currentID)
      : allRts

    if (rts.length === 0) {
      api.ui.toast({ message: "No roundtables from this session", variant: "info" })
      return
    }

    api.ui.dialog.replace(() => (
      <box padding={1} flexDirection="column">
        <text bold>Roundtables {currentID ? "(this session)" : "(all)"}</text>
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
