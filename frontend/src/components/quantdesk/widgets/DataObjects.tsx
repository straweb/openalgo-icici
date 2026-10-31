import { Crosshair, Shapes } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type CrossSyncMsg, onCross } from '../chart/canvas-chart'

// ============================================================
// Data objects — everything the selected chart carries:
//  · crosshair OHLCV of the hovered bar (chart crosshair bus)
//  · the chart's object inventory (drawings persisted per pane)
// Reading the drawing inventory: canvas-chart persists drawings in
// localStorage under `oa-qd-drawings:<settingsKey>`; the selected
// pane is tracked by the host page via useTerminal.selectedPaneKey.
// ============================================================

const DRAW_PREFIX = 'oa-qd-drawings:'

interface DrawRow {
  id: string
  tool?: string
  kind?: string
  [k: string]: unknown
}

function readDrawings(settingsKey: string): DrawRow[] {
  try {
    const raw = window.localStorage.getItem(DRAW_PREFIX + settingsKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed as DrawRow[]
    if (parsed && typeof parsed === 'object') {
      const vals = Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v))
      return (vals as DrawRow[]) ?? []
    }
    return []
  } catch {
    return []
  }
}

const toolLabel = (t: string | undefined): string => {
  const map: Record<string, string> = {
    trend: 'Trend line',
    ray: 'Ray',
    hray: 'Horizontal ray',
    hline: 'Horizontal line',
    vline: 'Vertical line',
    arrow: 'Arrow',
    free: 'Freehand',
    fib: 'Fib retracement',
    fibext: 'Fib extension',
    fibtz: 'Fib time zones',
    fan: 'Gann fan',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    circle: 'Circle',
    pricerange: 'Price range',
    pricedate: 'Price + date range',
    forecast: 'Forecast',
    long: 'Long position',
    short: 'Short position',
    vprofile: 'Volume profile',
    vbs: 'Volume buy/sell',
    text: 'Text',
    pricenote: 'Price note',
    pin: 'Pin',
    comment: 'Comment',
    callout: 'Callout',
    table: 'Stats table',
    pattern: 'Pattern',
  }
  return t ? (map[t] ?? t) : 'Object'
}

export function QuantDeskDataObjects({ paneKey }: { paneKey: string | null }) {
  const [cross, setCross] = useState<CrossSyncMsg | null>(null)
  const settingsKey = paneKey

  useEffect(() => onCross((m) => setCross(m)), [])

  // drawings refresh when the pane changes or a crosshair lands (cheap poll)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 4000)
    return () => clearInterval(iv)
  }, [])
  const drawings = useMemo(
    () => (settingsKey ? readDrawings(settingsKey) : []),
    [settingsKey, tick, cross?.t]
  )

  const ohlc = cross?.ohlc

  return (
    <div className="h-full flex flex-col text-[11px]">
      {/* crosshair data window */}
      <div className="px-2 pt-2 pb-1 text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Crosshair className="h-3 w-3" /> Hovered bar{cross?.symbol ? ` — ${cross.symbol}` : ''}
      </div>
      <div className="mx-2 rounded border border-border bg-secondary/30 px-2 py-1.5 grid grid-cols-5 gap-1 tabular">
        {(['o', 'h', 'l', 'c', 'v'] as const).map((k) => (
          <div key={k}>
            <div className="text-[8px] uppercase text-muted-foreground">
              {k === 'v' ? 'vol' : k}
            </div>
            <div className="text-[10px]">
              {ohlc ? (k === 'v' ? ohlc.v.toLocaleString('en-IN') : ohlc[k].toFixed(2)) : '—'}
            </div>
          </div>
        ))}
      </div>
      <div className="px-2 py-1 text-[9px] text-muted-foreground tabular">
        {cross?.t
          ? new Date(cross.t).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
          : 'hover a chart to read the crosshair'}{' '}
        · price {cross?.price != null ? cross.price.toFixed(2) : '—'} · tf {cross?.tf ?? '—'}
      </div>

      {/* object inventory */}
      <div className="px-2 pt-2 pb-1 text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Shapes className="h-3 w-3" /> Objects on this chart{' '}
        {settingsKey ? <span className="text-[8px]">({settingsKey})</span> : ''}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {!settingsKey && (
          <div className="text-[10px] text-muted-foreground py-1">
            Open a chart pane to list its objects.
          </div>
        )}
        {settingsKey && drawings.length === 0 && (
          <div className="text-[10px] text-muted-foreground py-1">
            No drawings — use the chart's left toolbar to draw lines, fibs, shapes or positions.
          </div>
        )}
        {settingsKey &&
          drawings.map((d, i) => (
            <div
              key={(d.id as string) ?? i}
              className="flex items-center gap-2 py-0.5 border-b border-border/50"
            >
              <span className="text-[9px] text-muted-foreground tabular w-5">{i + 1}</span>
              <span className="truncate flex-1">
                {toolLabel((d.tool as string) ?? (d.kind as string))}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}
