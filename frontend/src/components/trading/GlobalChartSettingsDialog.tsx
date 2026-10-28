/**
 * Global chart settings — the workspace-level twin of the per-pane gear.
 *
 * The per-chart settings dialog configures ONE pane. This one fans every
 * change out to ALL open charts, in place, without rebuilding anything:
 * the interval, the chart type, the ghost overlay, the grid lines, the
 * volume pane, the Buy/Sell strip — the toolbar settings — plus two
 * study actions (copy the focused chart's study set to every chart, clear
 * every chart) and the full engine settings form, whose patch applies to
 * every pane too.
 *
 * Reads the focused pane as the source of truth for current values, the
 * way the toolbar portals the focused pane's own controls. Everything is
 * a live terminal call, so a pane that refuses a value (an interval the
 * broker does not serve) keeps its own — the honest outcome.
 */

import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { CHART_TYPES } from '@/lib/trading/chartTypes'
import { GHOST_INTERVALS } from '@/lib/trading/ghostCandles'
import type { ChartSettingsRequest, TradingTerminal } from '@/lib/trading/terminal'
import { cn } from '@/lib/utils'
import { showToast } from '@/utils/toast'
import { ChartSettingsDialog } from './ChartSettingsDialog'

/** The intervals the global picker offers; a pane that cannot serve one keeps its own. */
const GLOBAL_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', 'D', 'W'] as const

interface Props {
  open: boolean
  onClose(): void
  /** Live read — the pane set can change while the dialog is open. */
  getTerminals(): TradingTerminal[]
  /** The focused pane: the source of the current values and the copy-from. */
  getFocused(): TradingTerminal | null
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[13px] leading-5">{label}</div>
        {hint && <div className="text-[11px] leading-4 text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b px-4 py-2 last:border-b-0">
      <div className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

const selectCls =
  'h-7 rounded-md border border-border bg-transparent px-2 text-xs font-medium outline-none focus-visible:border-ring'

export function GlobalChartSettingsDialog({ open, onClose, getTerminals, getFocused }: Props) {
  /** A snapshot id so the controls re-read when the dialog reopens. */
  const [epoch, setEpoch] = useState(0)
  const [interval, setInterval] = useState('')
  const [chartType, setChartType] = useState('candlestick')
  const [ghost, setGhost] = useState<string | null>(null)
  const [grid, setGrid] = useState({ vertical: true, horizontal: true })
  const [volumeOn, setVolumeOn] = useState(true)
  const [panelOn, setPanelOn] = useState(true)
  const [chartSettingsReq, setChartSettingsReq] = useState<ChartSettingsRequest | null>(null)
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot reads the getters once per open — they are stable refs on the page
  useEffect(() => {
    if (!open) return
    setEpoch((n) => n + 1)
    const focused = getFocused()
    const ctx = focused?.chartContext() ?? null
    setInterval(ctx?.interval ?? '5m')
    setChartType(ctx?.chart_type ?? 'candlestick')
    setGhost(focused ? readGhost(focused) : null)
    setGrid(focused ? focused.gridState() : { vertical: true, horizontal: true })
    setVolumeOn(focused ? focused.volumeVisible() : true)
    setPanelOn(focused ? focused.instantPanelVisible() : true)
    setChartSettingsReq(null)
  }, [open])

  /** Escape closes, like every other dialog on the page. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /** The ghost overlay's timeframe is pane state; read it from the toolbar's getter. */
  function readGhost(terminal: TradingTerminal): string | null {
    return (
      (terminal as unknown as { ghostInterval?: () => string | null }).ghostInterval?.() ?? null
    )
  }

  const each = useCallback(
    (run: (terminal: TradingTerminal) => void, what: string) => {
      const terminals = getTerminals()
      let applied = 0
      for (const terminal of terminals) {
        try {
          run(terminal)
          applied += 1
        } catch {
          // A pane that refuses a value keeps its own — the honest outcome.
        }
      }
      showToast.success(`${what}: ${applied} chart${applied === 1 ? '' : 's'} updated`)
    },
    [getTerminals]
  )

  if (!open) return null

  const focused = getFocused()

  const applyChartSettingsToAll = async (patch: Record<string, string | number | boolean>) => {
    const terminals = getTerminals()
    let applied = 0
    for (const terminal of terminals) {
      try {
        await terminal.applyChartSettings(patch)
        applied += 1
      } catch {
        /* a pane keeps its own when the patch will not take */
      }
    }
    showToast.success(`Chart settings: ${applied} chart${applied === 1 ? '' : 's'} updated`)
  }

  const copyStudiesToAll = async () => {
    if (!focused) return
    const captured = focused.captureIndicatorTemplate()
    if (captured.length === 0) {
      showToast.warning('The focused chart has no studies to copy')
      return
    }
    setBusy(true)
    let applied = 0
    for (const terminal of getTerminals()) {
      if (terminal === focused) continue
      try {
        await terminal.applyIndicatorTemplate(captured, 'replace')
        applied += 1
      } catch (e) {
        showToast.warning(
          `One chart refused the studies: ${e instanceof Error ? e.message : 'unknown reason'}`
        )
      }
    }
    setBusy(false)
    showToast.success(`Studies copied to ${applied} chart${applied === 1 ? '' : 's'}`)
  }

  const clearStudiesEverywhere = () => {
    let removed = 0
    for (const terminal of getTerminals()) {
      for (const inst of terminal.listIndicators()) {
        try {
          terminal.removeIndicatorById(inst.id)
          removed += 1
        } catch {
          /* keep going */
        }
      }
    }
    showToast.success(`${removed} stud${removed === 1 ? 'y' : 'ies'} removed`)
  }

  const copyChartSettingsToAll = async () => {
    if (!focused) return
    const req = await focused.chartSettings()
    if (!req) {
      showToast.warning('The chart settings could not be read')
      return
    }
    // Only the deviations travel: the defaults are every pane's own baseline.
    const patch: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(req.values)) {
      if (req.defaults[k] !== v) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      showToast.info('The focused chart is at its defaults — nothing to copy')
      return
    }
    await applyChartSettingsToAll(patch)
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div className="flex max-h-[92%] w-[420px] flex-col rounded-lg border bg-popover shadow-2xl">
        <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight">Global chart settings</h3>
            <p className="text-[11px] text-muted-foreground">
              Applies to every open chart, right now
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" key={epoch}>
          <Section title="Frame">
            <Row label="Interval" hint="Every chart moves to this timeframe">
              <select
                className={selectCls}
                value={interval}
                onChange={(e) => {
                  const v = e.target.value
                  setInterval(v)
                  each((t) => {
                    t.chooseInterval(v)
                  }, `Interval ${v}`)
                }}
                aria-label="Global interval"
              >
                {GLOBAL_INTERVALS.map((iv) => (
                  <option key={iv} value={iv}>
                    {iv}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Chart type" hint="Candles, lines, boxes — the whole set">
              <select
                className={selectCls}
                value={chartType}
                onChange={(e) => {
                  const v = e.target.value
                  setChartType(v)
                  each(
                    (t) => {
                      t.chooseChartType(v)
                    },
                    `Chart type ${CHART_TYPES[v]?.label ?? v}`
                  )
                }}
                aria-label="Global chart type"
              >
                {Object.entries(CHART_TYPES).map(([id, def]) => (
                  <option key={id} value={id}>
                    {def.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Ghost candles" hint="The higher-timeframe overlay">
              <select
                className={selectCls}
                value={ghost ?? ''}
                onChange={(e) => {
                  const v = e.target.value === '' ? null : e.target.value
                  setGhost(v)
                  each(
                    (t) => {
                      t.setGhostInterval(v)
                    },
                    `Ghost candles ${v ?? 'off'}`
                  )
                }}
                aria-label="Global ghost candles"
              >
                <option value="">Off</option>
                {GHOST_INTERVALS.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </Row>
          </Section>

          <Section title="Show / hide">
            <Row label="Volume" hint="The volume histogram under the candles">
              <Switch
                checked={volumeOn}
                onCheckedChange={(v) => {
                  setVolumeOn(v)
                  each((t) => {
                    t.setVolumeVisible(v)
                  }, 'Volume')
                }}
                aria-label="Global volume"
              />
            </Row>
            <Row label="Vertical grid" hint="The time gridlines">
              <Switch
                checked={grid.vertical}
                onCheckedChange={(v) => {
                  const next = { ...grid, vertical: v }
                  setGrid(next)
                  each((t) => {
                    t.setGrid(next.vertical, next.horizontal)
                  }, 'Vertical grid')
                }}
                aria-label="Global vertical grid"
              />
            </Row>
            <Row label="Horizontal grid" hint="The price gridlines">
              <Switch
                checked={grid.horizontal}
                onCheckedChange={(v) => {
                  const next = { ...grid, horizontal: v }
                  setGrid(next)
                  each((t) => {
                    t.setGrid(next.vertical, next.horizontal)
                  }, 'Horizontal grid')
                }}
                aria-label="Global horizontal grid"
              />
            </Row>
            <Row label="Buy / Sell strip" hint="The SELL · slider · BUY buttons on every chart">
              <Switch
                checked={panelOn}
                onCheckedChange={(v) => {
                  setPanelOn(v)
                  each((t) => {
                    t.setInstantPanelVisible(v)
                  }, 'Buy/Sell strip')
                }}
                aria-label="Global Buy/Sell strip"
              />
            </Row>
          </Section>

          <Section title="Studies">
            <Row
              label="Copy studies to all charts"
              hint="The focused chart's study set replaces the others'"
            >
              <button
                type="button"
                disabled={!focused || busy}
                onClick={() => void copyStudiesToAll()}
                className="rounded border border-foreground/25 px-2.5 py-1 text-xs transition-colors hover:border-foreground/50 hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                Copy
              </button>
            </Row>
            <Row label="Remove all studies" hint="Clears every chart's panes">
              <button
                type="button"
                onClick={clearStudiesEverywhere}
                className="rounded border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                Clear all
              </button>
            </Row>
          </Section>

          <Section title="Chart settings">
            <Row
              label="Copy the focused chart's settings"
              hint="Every appearance, axis and readout change it carries"
            >
              <button
                type="button"
                disabled={!focused}
                onClick={() => void copyChartSettingsToAll()}
                className="rounded border border-foreground/25 px-2.5 py-1 text-xs transition-colors hover:border-foreground/50 hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                Copy
              </button>
            </Row>
            <Row
              label="Open the full settings form"
              hint="The per-chart gear's every tab — the patch lands on all charts"
            >
              <button
                type="button"
                disabled={!focused}
                onClick={() => {
                  if (!focused) return
                  void focused
                    .chartSettings()
                    .then((req) => {
                      if (req) setChartSettingsReq(req)
                      else showToast.warning('The chart settings could not be read')
                    })
                    .catch(() => showToast.warning('The chart settings could not be read'))
                }}
                className={cn(
                  'rounded border border-foreground/25 px-2.5 py-1 text-xs transition-colors hover:border-foreground/50 hover:bg-accent',
                  'disabled:pointer-events-none disabled:opacity-40'
                )}
              >
                Open
              </button>
            </Row>
          </Section>
        </div>

        <div className="flex shrink-0 items-center justify-end border-t px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-foreground px-5 py-1 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>

      {chartSettingsReq && (
        <ChartSettingsDialog
          req={chartSettingsReq}
          onApply={(patch) => {
            void applyChartSettingsToAll(patch)
          }}
          onClose={() => setChartSettingsReq(null)}
        />
      )}
    </div>
  )
}
