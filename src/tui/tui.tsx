/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"

let api: TuiPluginApi

function currentSessionID(): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  return route.params?.sessionID as string | undefined
}

function loadRTMap(): Record<string, string> {
  try { return api.kv.get("rt-parents") ?? {} } catch { return {} }
}

function saveRTMap(map: Record<string, string>) {
  try { api.kv.set("rt-parents", map) } catch { /* best-effort */ }
}

async function showRoundtables() {
  try {
    const currentID = currentSessionID()
    const rtMap = loadRTMap()
    const allIds = Object.keys(rtMap)

    if (allIds.length === 0) {
      api.ui.toast({ message: "No roundtables recorded", variant: "info" })
      return
    }

    const res = await api.client.session.list()
    const sessions = (res.data ?? []) as { id: string; title?: string }[]
    const sessionMap = new Map(sessions.map((s) => [s.id, s]))

    const entries: { child: string; title: string; parent: string }[] = []
    for (const childId of allIds) {
      const parentId = rtMap[childId]
      const s = sessionMap.get(childId)
      if (s) entries.push({ child: childId, title: s.title ?? "", parent: parentId })
    }

    const visible = currentID
      ? entries.filter((e) => e.parent === currentID)
      : entries

    if (visible.length === 0) {
      api.ui.toast({ message: "No roundtables from this session", variant: "info" })
      return
    }

    api.ui.dialog.replace(() => (
      <box padding={1} flexDirection="column">
        <text bold>Roundtables {currentID ? "(this session)" : "(all)"}</text>
        {visible.map((e) => (
          <box
            flexDirection="row"
            paddingTop={1}
            onMouseUp={() => {
              api.ui.dialog.clear()
              api.route.navigate("session", { sessionID: e.child })
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
              <text>{e.title.replace(/^⚡|\(Roundtable\) - /, "").slice(0, 80)}</text>
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

  // Listen for session.created events to build parent-child registry
  api.event.on("session.created", (event: any) => {
    const info = event?.properties?.info
    if (!info?.id) return
    const title = (info.title ?? "") as string
    if (!title.startsWith("(Roundtable)") && !title.startsWith("⚡")) return
    const map = loadRTMap()
    map[info.id] = info.parentID ?? info.parent_session_id ?? ""
    saveRTMap(map)
  })

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
