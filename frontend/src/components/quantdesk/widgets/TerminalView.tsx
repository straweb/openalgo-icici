import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Crosshair, Grid3x3, Layers, Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { DockTab } from '@/components/trading/dock/dockState'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SearchRow } from '@/lib/trading/terminal'
import { api, registerExchange } from '../lib/client-api'
import { addDepthPanelTo, useTerminal, type WsLayout, wsLayout } from '../lib/store'
import { TIMEFRAMES, type Timeframe } from '../lib/types'
import { ActionBar } from './ActionBar'
import { ChartsPane } from './ChartsPane'
import { RightWidgets } from './RightWidgets'
import { useQuantdeskScheduler } from './scheduler'
import { TopBar } from './TopBar'

// The bottom dock reuses OpenAlgo's proven dock shell — the exact tab set
// the page needs: positions, orders, trade, GTT, Schedule, depth — with
// the blotter engines (scheduler + brackets + order updates) attached.
const TradingDock = lazy(() =>
  import('@/components/trading/dock/TradingDock').then((m) => ({ default: m.TradingDock }))
)

// ============================================================
// QuantDesk terminal layout:
//
//   TopBar       logo · workspace tabs · underlying+series · menu
//   toolbar      timeframes · volume · layouts · strikes overlay · depth
//   middle       charts pane (left, resizable) | right widget tabs
//   action bar   session capital · order settings · quick deploy · level deploy
//   dock         positions · orders · trade · gtt · schedule · depth
// ============================================================

const LAYOUT_BTNS: [WsLayout, string, string][] = [
  ['single', '1', 'Single chart pane'],
  ['spot-atm', 'S+2', 'Spot top · ATM CE / PE panes below'],
  ['grid4', '2×2', 'Spot + CE + PE + scratch pane'],
  ['v2', 'T+1', 'Top chart + 1 row below'],
  ['v3', 'T+2', 'Top chart + 2 rows below'],
  ['h2', 'L+1', 'Left chart + 1 column right'],
  ['h3', 'L+2', 'Left chart + 2 columns right'],
]

export function TerminalView({ apiKey, wsUrl }: { apiKey: string; wsUrl: string }) {
  const workspaces = useTerminal((s) => s.workspaces)
  const activeWs = useTerminal((s) => s.activeWs)
  const ws = workspaces.find((w) => w.id === activeWs) ?? workspaces[0]
  const patchWs = useTerminal((s) => s.patchWs)
  const bottomCollapsed = useTerminal((s) => s.bottomCollapsed)
  const setBottomCollapsed = useTerminal((s) => s.setBottomCollapsed)
  const setSymbol = useTerminal((s) => s.setSymbol)
  const [focusedPaneKey, setFocusedPaneKey] = useState<string | null>(null)
  const [dockTab, setDockTab] = useState<DockTab | null>('positions')
  // quantdesk schedule rows fire here (action bar Schedule popover)
  useQuantdeskScheduler()

  const layout = ws ? wsLayout(ws) : 'single'
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const isFnOUnderlying = useMemo(
    () => !!ws && (undData?.underlyings ?? []).some((u) => u.underlying === ws.symbol),
    [ws, undData]
  )

  /** Chart a picked row (dock tables / watchlist / chain) in the workspace. */
  const onPick = useCallback(
    (row: SearchRow) => {
      registerExchange(row.symbol, row.exchange)
      setSymbol(row.symbol)
    },
    [setSymbol]
  )

  if (!ws) return null

  return (
    <div className="flex h-full flex-col min-h-0">
      <TopBar />

      {/* chart toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-card/30 shrink-0 overflow-x-auto">
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-[10px]">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => patchWs(ws.id, { tf: tf as Timeframe })}
              className={`px-1.5 py-0.5 rounded ${ws.tf === tf ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >
              {tf}
            </button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          <button
            type="button"
            onClick={() => patchWs(ws.id, { showVolume: !ws.showVolume })}
            title="Default volume state for NEW charts of this workspace (each chart has its own controls)"
            className={`px-1.5 py-0.5 rounded ${ws.showVolume ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'}`}
          >
            Vol
          </button>
          <span className="w-px h-4 bg-border mx-0.5" />
          {LAYOUT_BTNS.map(([l, label, tip]) => (
            <button
              key={l}
              type="button"
              onClick={() => patchWs(ws.id, { layout: l })}
              title={tip}
              className={`px-1.5 py-0.5 rounded text-[10px] tabular ${layout === l ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
          <span className="w-px h-4 bg-border mx-0.5" />
          {isFnOUnderlying && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`px-1.5 py-0.5 rounded flex items-center gap-1 ${(ws.strikeOverlay ?? true) ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'}`}
                  title="Strike overlay — dotted marker at every ATM±7 strike with CE/PE quick B/S rows (auto lots from % of capital)"
                >
                  <Grid3x3 className="h-3 w-3" /> strikes
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-2 text-[10px]" align="end">
                <label className="flex items-center gap-2 py-0.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ws.strikeOverlay ?? true}
                    onChange={(ev) => patchWs(ws.id, { strikeOverlay: ev.target.checked })}
                    className="accent-[#f5a623] h-3 w-3"
                  />
                  show strike rows on the spot chart
                </label>
                <div className="flex items-center gap-1.5 py-0.5">
                  <span className="text-muted-foreground">lots % of capital</span>
                  <input
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.5}
                    value={ws.lotsPct ?? 10}
                    onChange={(ev) =>
                      patchWs(ws.id, {
                        lotsPct: Math.max(0.1, Math.min(100, Number(ev.target.value) || 10)),
                      })
                    }
                    className="w-12 h-5 rounded bg-secondary/70 px-1 text-[10px] tabular outline-none focus:ring-1 ring-primary/60"
                  />
                </div>
                <div className="text-[8px] text-muted-foreground leading-snug pt-0.5">
                  lots = capital × % ÷ (premium × lot size) — recalculated live per strike as prices
                  move
                </div>
              </PopoverContent>
            </Popover>
          )}
          <span className="w-px h-4 bg-border mx-0.5" />
          <button
            type="button"
            onClick={() => {
              const { patch, error } = addDepthPanelTo(ws, ws.symbol)
              if (error) {
                toast.info(error)
                return
              }
              patchWs(ws.id, patch)
              toast.success(`Depth panel added — ${ws.symbol}`)
            }}
            title="Add this chart's market depth to the watchlist depth stack"
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <Layers className="h-3 w-3" /> depth
          </button>
          <span
            className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex items-center gap-1"
            title="Wheel: time zoom · Wheel on price axis / Shift+wheel: price zoom · Drag: free pan · Double-click / ▶LIVE: reset · Goto: calendar + time in the chart toolbar"
          >
            <Crosshair className="h-3 w-3" /> zoom/pan
          </span>
        </div>
      </div>

      {/* middle: charts pane | right widget tabs */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0">
          <ChartsPane ws={ws} focusedPaneKey={focusedPaneKey} onFocusedPane={setFocusedPaneKey} />
        </div>
        <div className="w-[300px] xl:w-[340px] 2xl:w-[380px] shrink-0 min-h-0">
          <RightWidgets
            ws={ws}
            apiKey={apiKey}
            wsUrl={wsUrl}
            focusedPaneKey={focusedPaneKey ?? `${ws.id}:spot`}
            onPick={onPick}
          />
        </div>
      </div>

      {/* action bar + bottom dock */}
      <ActionBar ws={ws} apiKey={apiKey} />
      {bottomCollapsed ? (
        <button
          type="button"
          onClick={() => setBottomCollapsed(false)}
          className="flex items-center gap-1.5 px-2 h-7 border-t border-border bg-card text-[10px] text-muted-foreground hover:text-foreground shrink-0"
          title="Expand the dock"
        >
          <Maximize2 className="h-3 w-3" /> dock
        </button>
      ) : (
        <div className="h-[240px] shrink-0 border-t-0 min-h-0 flex flex-col">
          <div className="flex items-center justify-end px-1 h-6 border-y border-border bg-card/30 shrink-0">
            <button
              type="button"
              onClick={() => setBottomCollapsed(true)}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground"
              title="Collapse the dock"
            >
              <Minimize2 className="h-3 w-3" />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <Suspense
              fallback={
                <div className="grid place-items-center h-full text-[11px] text-muted-foreground">
                  <CalendarClock className="h-4 w-4 animate-pulse mr-1" /> Loading dock…
                </div>
              }
            >
              <TradingDock
                tab={dockTab}
                onTabChange={setDockTab}
                apiKey={apiKey}
                onPick={onPick}
                activeSymbol={ws.symbol}
                tradingLocked={() => false}
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}
