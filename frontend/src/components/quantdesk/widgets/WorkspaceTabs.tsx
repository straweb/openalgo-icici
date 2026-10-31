import { Plus, X } from 'lucide-react'
import { useTerminal } from '../lib/store'

// Workspace tabs — ported from the quanttrade terminal toolbar; the host
// page mounts them in the top bar (logo at left, tabs beside it).
export function WorkspaceTabs() {
  const workspaces = useTerminal((s) => s.workspaces)
  const activeWs = useTerminal((s) => s.activeWs)
  const setActiveWs = useTerminal((s) => s.setActiveWs)
  const addWs = useTerminal((s) => s.addWs)
  const removeWs = useTerminal((s) => s.removeWs)

  return (
    <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
      {workspaces.map((w) => (
        <div
          key={w.id}
          onClick={() => setActiveWs(w.id)}
          className={`group flex items-center gap-1 px-2.5 py-1 rounded-t text-[11px] cursor-pointer border-b-2 transition-colors shrink-0 ${
            activeWs === w.id
              ? 'border-primary text-foreground bg-card/60'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="max-w-32 truncate">{w.name}</span>
          <span className="text-[9px] text-muted-foreground">{w.symbol}</span>
          {workspaces.length > 1 && (
            <X
              className="h-3 w-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                removeWs(w.id)
              }}
            />
          )}
        </div>
      ))}
      <button
        onClick={addWs}
        className="p-1 rounded text-muted-foreground hover:text-foreground shrink-0"
        title="New workspace"
        type="button"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
