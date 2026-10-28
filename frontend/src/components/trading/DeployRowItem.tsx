/**
 * One row of the Deploy panel, drawn the way a trader reads a ladder:
 *
 * Line 1 — what it is: the symbol tile (strike with its ITM/OTM badge, or
 * the stock's name), its price with the rupees one lot (or one share)
 * carries, and to the right the row's P&L plus the Min / Chart / Quit /
 * Depth / remove actions. Quit shows only while a broker position is open
 * on the row and flattens that position; Depth loads the instrument into
 * the dock's depth tab.
 *
 * Line 2 — what it trades: the percent of the session capital this row
 * carries — a slider plus a type-in box, auto-levelled with its side so
 * the shares always sum to 100 — the lots (or shares) that percent buys
 * right now, the rupee amount that quantity needs, and the Edit / Exit /
 * Buy / Sell actions.
 *
 * Line 3 — the levels, behind the Edit press: entry, target, stop. The row
 * lights when its instrument is the charted one, when a position or a live
 * order exists on it, and its level badges light when LTP crosses them.
 */

import {
  ChevronDown,
  ChevronUp,
  LineChart,
  ListTree,
  LogOut,
  Minimize2,
  Pencil,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { autoLots, type DeployRow, rowRequired } from '@/lib/trading/deployPlan'
import { cn } from '@/lib/utils'

const fmtINR = (value: number): string => {
  const sign = value < 0 ? '−' : ''
  return `${sign}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

interface Props {
  row: DeployRow
  ltp?: number
  /** The strike-depth accent colour (options), null for stocks. */
  accent: string | null
  /** "ATM" / "ITM 2" / "OTM 3" — the offset badge text (options). */
  offsetLabel: string | null
  /** The trading funds the weight shares divide. */
  capital: number
  pnl?: number
  inChart: boolean
  hasPosition: boolean
  hasOrder: boolean
  targetHit: boolean
  stopHit: boolean
  collapsed: boolean
  onToggleCollapse(): void
  onToggle(): void
  onWeight(weight: number): void
  onLevels(levels: { entry: number | null; target: number | null; stoploss: number | null }): void
  onFire(action: 'BUY' | 'SELL'): void
  /** Sell this row's planned quantity (the quick flat, per row). */
  onExit(): void
  /** Flatten the open broker position on this row (shown only when one exists). */
  onQuit(): void
  onChart(): void
  /** Load this instrument into the dock's Depth tab. */
  onDepth(): void
  onRemove(): void
}

function NumField(props: {
  label: string
  value: number | null
  hit?: boolean
  onCommit(value: number | null): void
}) {
  const [draft, setDraft] = useState(props.value?.toString() ?? '')
  return (
    <label className="flex items-center gap-1" title={props.label}>
      <span
        className={cn(
          'text-[9px] font-semibold uppercase',
          props.hit ? 'text-amber-600' : 'text-muted-foreground'
        )}
      >
        {props.label}
      </span>
      <Input
        value={draft}
        inputMode="decimal"
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft)
          props.onCommit(draft.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={cn(
          'h-5 w-[58px] px-1 font-mono text-[10px] tabular-nums',
          props.hit && 'border-amber-500 text-amber-600'
        )}
      />
    </label>
  )
}

export function DeployRowItem(props: Props) {
  const { row } = props
  const [editOpen, setEditOpen] = useState(false)
  const ltp = props.ltp
  const manual = row.lots > 0
  const autoLotCount = autoLots(row, ltp, props.capital)
  const qty = manual ? row.lots * row.lotSize : autoLotCount * row.lotSize
  const required = rowRequired(row, ltp, props.capital)
  const showLevels = !props.collapsed && editOpen
  const perUnit = row.lotSize > 1 ? `${row.lotSize}/lot` : 'sh'
  return (
    <div
      className={cn(
        'border-b px-1.5 py-1',
        !row.enabled && 'opacity-50',
        props.inChart && 'bg-sky-500/10 ring-1 ring-inset ring-sky-500/60',
        props.hasPosition && 'bg-emerald-500/5',
        props.hasOrder && 'bg-amber-500/5'
      )}
      style={
        props.accent && !props.hasPosition && !props.hasOrder
          ? { borderLeft: `2px solid ${props.accent}` }
          : undefined
      }
      data-symbol={row.symbol}
    >
      {/* Line 1: identity + price + pnl + row actions. One compact token per
          row: `22800 CE OTM1 0.05/₹3` — strike, side, moneyness, the live
          price over the rupees one lot (or one share) carries. */}
      <div className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={props.onToggle}
          className="h-3 w-3 shrink-0"
          aria-label={`Enable ${row.symbol}`}
        />
        <span
          className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden whitespace-nowrap font-mono text-[11px] font-semibold tabular-nums"
          title={
            ltp != null
              ? `${row.symbol} — one ${row.lotSize > 1 ? `lot (${row.lotSize})` : 'share'} ≈ ₹${Math.round(
                  ltp * row.lotSize
                ).toLocaleString('en-IN')}`
              : row.symbol
          }
        >
          {row.kind === 'option' ? (
            <>
              <span className="shrink-0">{row.strike}</span>
              <span
                className={cn(
                  'shrink-0',
                  row.optionType === 'CE' ? 'text-emerald-600' : 'text-red-600'
                )}
              >
                {row.optionType}
              </span>
              {props.offsetLabel && (
                <span className="shrink-0 text-[9px] font-semibold text-muted-foreground">
                  {props.offsetLabel.replace(' ', '')}
                </span>
              )}
            </>
          ) : (
            <span className="max-w-[86px] shrink-0 truncate">{row.name || row.symbol}</span>
          )}
          {ltp != null && (
            <span className="shrink-0">
              {ltp.toFixed(2)}
              <span className="font-normal text-muted-foreground">
                /₹{Math.round(ltp * row.lotSize).toLocaleString('en-IN')}
              </span>
            </span>
          )}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 font-mono text-[10px] tabular-nums',
            props.pnl == null
              ? 'text-muted-foreground/60'
              : props.pnl >= 0
                ? 'text-emerald-600'
                : 'text-red-600'
          )}
          title={props.hasPosition ? 'Position P&L' : 'P&L vs the entry level'}
        >
          {props.pnl != null ? fmtINR(props.pnl) : '—'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 px-0"
          onClick={props.onToggleCollapse}
          title={props.collapsed ? 'Expand the row' : 'Minimize the row'}
        >
          {props.collapsed ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <Minimize2 className="h-3 w-3" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 px-0"
          onClick={props.onChart}
          title="Load this instrument in the chart"
        >
          <LineChart className="h-3 w-3" />
        </Button>
        {props.hasPosition && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 shrink-0 px-0 text-amber-600 hover:text-amber-700"
            onClick={props.onQuit}
            title="Quit: flatten the open position on this row"
          >
            <LogOut className="h-3 w-3" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 px-0"
          onClick={props.onDepth}
          title="Show market depth in the dock's Depth tab"
        >
          <ListTree className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-4 shrink-0 px-0 text-muted-foreground"
          onClick={props.onRemove}
          title="Remove this row"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Line 2: sizing (slider + percent) + required amount + trade actions */}
      {!props.collapsed && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span
            className="flex items-center gap-0.5 rounded bg-muted/60 px-1 py-px"
            title="Percent of the funds this row carries (sides auto-adjust to 100%)"
          >
            <input
              type="number"
              min={1}
              max={100}
              step={0.1}
              value={row.weight || ''}
              placeholder="0"
              onChange={(e) => props.onWeight(Number(e.target.value))}
              className="w-9 bg-transparent text-right font-mono text-[10px] tabular-nums outline-none"
              aria-label="Weight percent"
            />
            <span className="text-[9px] text-muted-foreground">%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={Math.min(100, Math.max(0, row.weight))}
            onChange={(e) => props.onWeight(Number(e.target.value))}
            className="h-1 w-14 shrink-0 cursor-pointer accent-sky-600"
            aria-label="Weight percent slider"
          />
          <span
            className="min-w-[58px] font-mono text-[10px] tabular-nums"
            title={
              manual
                ? 'Manual lots (this row overrides the auto size)'
                : 'Auto lots from this row’s weight share of the funds'
            }
          >
            {qty > 0 ? (
              <>
                {row.lotSize > 1
                  ? `${qty / row.lotSize} lot${qty / row.lotSize === 1 ? '' : 's'}`
                  : `${qty} sh`}
                <span className="ml-1 text-[9px] text-muted-foreground">({qty})</span>
              </>
            ) : (
              <span className="text-muted-foreground">0 {perUnit}</span>
            )}
          </span>
          <span
            className={cn(
              'font-mono text-[10px] tabular-nums',
              required <= 0 ? 'text-muted-foreground' : 'text-foreground'
            )}
            title="Amount required to buy this row's quantity at the live price"
          >
            {required > 0 ? `≈ ${fmtINR(required)}` : '≈ ₹0'}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant={editOpen ? 'secondary' : 'ghost'}
              className="h-5 w-5 px-0"
              onClick={() => setEditOpen((v) => !v)}
              title="Entry, target, stop loss"
            >
              <Pencil className="h-2.5 w-2.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-5 px-1 text-[9px]"
              disabled={qty <= 0}
              onClick={props.onExit}
              title="Sell this row's quantity"
            >
              Exit
            </Button>
            <Button
              size="sm"
              className="h-5 bg-emerald-600 px-1.5 text-[10px] text-white hover:bg-emerald-700"
              disabled={qty <= 0}
              onClick={() => props.onFire('BUY')}
              title={`Buy ${row.symbol}`}
            >
              B
            </Button>
            <Button
              size="sm"
              className="h-5 bg-red-600 px-1.5 text-[10px] text-white hover:bg-red-700"
              disabled={qty <= 0}
              onClick={() => props.onFire('SELL')}
              title={`Sell ${row.symbol}`}
            >
              S
            </Button>
          </div>
        </div>
      )}

      {/* Line 3: the levels, behind the Edit press */}
      {showLevels && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded bg-muted/40 px-1.5 py-1">
          <NumField
            label="Entry"
            value={row.entry}
            onCommit={(entry) =>
              props.onLevels({ entry, target: row.target, stoploss: row.stoploss })
            }
          />
          <NumField
            label="Target"
            value={row.target}
            hit={props.targetHit}
            onCommit={(target) =>
              props.onLevels({ entry: row.entry, target, stoploss: row.stoploss })
            }
          />
          <NumField
            label="SL"
            value={row.stoploss}
            hit={props.stopHit}
            onCommit={(stoploss) =>
              props.onLevels({ entry: row.entry, target: row.target, stoploss })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-5 w-5 px-0"
            onClick={() => setEditOpen(false)}
            title="Hide the levels"
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  )
}
