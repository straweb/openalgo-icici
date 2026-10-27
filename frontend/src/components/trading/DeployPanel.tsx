/**
 * The deploy panel: a strike ladder built the hedging terminal's way, and the
 * quick actions that fire it in one tap.
 *
 * The strip at the top is the HedgingDock's quick actions, narrowed to one
 * market: Deploy CE / Deploy PE buys every enabled row of that side, Close
 * flattens it, Exit All clears both. The add strip under it is the hedging
 * InstrumentPanel's: ATM, a +/- direction toggle, one-tap offsets 1..10, an
 * N-strikes picker (the same strikesForPick arithmetic, imported from the
 * hedging lib rather than copied) and a custom strike. Rows resolve through
 * the live chain snapshot, so every row is an exact listed symbol, and LTPs
 * ride the same five-second chain poll the option chain panel used before
 * its websocket.
 *
 * Rows, product, price type and lots are remembered per underlying, so the
 * ladder a trader built yesterday is the ladder that opens today.
 */

import { CirclePlus, Loader2, RefreshCw, Rocket, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { optionChainApi } from '@/api/option-chain'
import { scalpingApi } from '@/api/scalping'
import { strikeAccent } from '@/components/hedging/InstrumentPanel'
import type { ChartContext } from '@/lib/trading/chartContract'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { tradingApi } from '@/api/trading'
import {
  bookKey,
  chainLtp,
  defaultDeployState,
  firingRows,
  readDeployState,
  rowsFromStrikes,
  type DeployBook,
  type DeployRow,
  writeDeployState,
} from '@/lib/trading/deployPlan'
import { strikesForPick } from '@/lib/hedging/indexLevels'
import { fnoExchangeFor } from '@/types/hedging'
import type { OptionChainResponse } from '@/types/option-chain'
import { cn } from '@/lib/utils'
import { PANEL_HEADER, PanelShell } from './panelShell'
import { showToast } from '@/utils/toast'

/** The hedging panel's one-tap ladder, shortened to fit a side panel. */
const OFFSET_BUTTONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const CHAIN_POLL_MS = 5000

interface Props {
  apiKey: string
  /**
   * The focused pane's instrument, read fresh like the Backtest panel reads
   * its own: the ladder follows the chart the trader is looking at, and the
   * revision tells the panel when that answer has changed.
   */
  getChartContext(): ChartContext | null
  chartRevision: number
}

interface Busy {
  deployCE: boolean
  deployPE: boolean
  closeCE: boolean
  closePE: boolean
}

const NO_BUSY: Busy = { deployCE: false, deployPE: false, closeCE: false, closePE: false }

export function DeployPanel({ apiKey, getChartContext, chartRevision }: Props) {
  const [state, setState] = useState<DeployBook>(defaultDeployState)
  const [side, setSide] = useState<'CE' | 'PE'>('CE')
  const [dir, setDir] = useState<1 | -1>(1)
  const [chain, setChain] = useState<OptionChainResponse | null>(null)
  const [expiry, setExpiry] = useState('')
  const [expiries, setExpiries] = useState<string[]>([])
  const [nOpen, setNOpen] = useState(false)
  const [nCount, setNCount] = useState(5)
  const [custom, setCustom] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [busy, setBusy] = useState<Busy>(NO_BUSY)
  const [chainError, setChainError] = useState<string | null>(null)

  // The panel is a trading surface: what the trader built survives a reload,
  // per underlying, the way the hedging terminal's boards do.
  useEffect(() => {
    setState(readDeployState())
  }, [])
  const save = useCallback((next: DeployBook) => {
    setState(next)
    writeDeployState(next)
  }, [])

  /** The charted instrument and the options exchange its derivatives trade on. */
  const ctx = useMemo(
    () => getChartContext(),
    // Deliberate re-read trigger, the Backtest panel's chartRevision contract:
    // the chart is not a React value, the counter says when to ask again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the re-read trigger
    [getChartContext, chartRevision]
  )
  const underlying = ctx?.symbol ?? ''
  const optionsExchange = useMemo(() => fnoExchangeFor(ctx?.exchange ?? 'NSE'), [ctx?.exchange])
  const key = bookKey(optionsExchange, underlying)
  const rows = state.books[key]?.[side === 'CE' ? 'ce' : 'pe'] ?? []

  const patchRows = useCallback(
    (side: 'CE' | 'PE', rows: DeployRow[]) => {
      setState((previous) => {
        const bookKeyStr = bookKey(optionsExchange, underlying)
        const book = previous.books[bookKeyStr] ?? { ce: [], pe: [] }
        const next: DeployBook = {
          ...previous,
          books: { ...previous.books, [bookKeyStr]: { ...book, [side === 'CE' ? 'ce' : 'pe']: rows } },
        }
        writeDeployState(next)
        return next
      })
    },
    [optionsExchange, underlying]
  )

  /* ── expiries, then the chain ─────────────────────────────────────────── */
  const loadExpiries = useCallback(async () => {
    if (!underlying) return
    try {
      const res = await scalpingApi.getExpiry(underlying, optionsExchange, 'options')
      const list = res.data ?? []
      setExpiries(list)
      setExpiry((current) => (current && list.includes(current) ? current : (list[0] ?? '')))
      setChainError(list.length === 0 ? `${underlying} has no option chain listed` : null)
    } catch {
      setChainError(`Could not load expiries for ${underlying}`)
    }
  }, [underlying, optionsExchange])

  useEffect(() => {
    setChain(null)
    setExpiries([])
    setExpiry('')
    setChainError(null)
    void loadExpiries()
  }, [loadExpiries])

  const loadChain = useCallback(async () => {
    if (!underlying || !expiry) return
    try {
      const res = await optionChainApi.getOptionChain(
        apiKey,
        underlying,
        optionsExchange,
        expiry,
        50
      )
      if (res.status === 'success') {
        setChain(res)
        setChainError(null)
      } else {
        setChainError(res.message || 'Chain snapshot unavailable')
      }
    } catch {
      setChainError('Chain snapshot unavailable')
    }
  }, [apiKey, underlying, optionsExchange, expiry])

  useEffect(() => {
    void loadChain()
    // The chain poll is the panel's price feed: the ladder's LTPs move with it.
    const timer = window.setInterval(() => void loadChain(), CHAIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadChain])

  /* ── add strips ────────────────────────────────────────────────────────── */
  const addStrikes = useCallback(
    (strikes: number[]) => {
      const { rows: next, skipped } = rowsFromStrikes(chain, side, strikes, rows, optionsExchange)
      patchRows(side, next)
      // A strike the snapshot does not list is not invented — but a click
      // that adds nothing must say so, or it reads as a dead button.
      if (skipped.length > 0) {
        showToast.warning(
          `${side}: ${skipped.length} strike${skipped.length === 1 ? '' : 's'} not on the chain snapshot (not listed) — the rest added.`
        )
      }
    },
    [chain, side, rows, optionsExchange, patchRows]
  )

  // The snapshot's ATM anchors the ladder; a broker that omits the field
  // falls back to the underlying LTP rounded onto the strike grid, so the
  // strip still works instead of waiting on a field that never lands.
  const interval = useMemo(() => {
    const strikes = chain?.chain.map((row) => row.strike) ?? []
    if (strikes.length < 2) return 0
    const sorted = [...new Set(strikes)].sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((s, i) => s - sorted[i])
    return Math.min(...gaps.filter((g) => g > 0)) || 0
  }, [chain])
  const atm =
    chain?.atm_strike ||
    (chain?.underlying_ltp && interval ? Math.round(chain.underlying_ltp / interval) * interval : null)

  // The ± button inverts what "1..10" and the N picker mean: offsets above or
  // below ATM, exactly the hedging add-strip's behaviour.
  const offsetStrikes = (offsets: number[]) => {
    if (!atm || !interval) return []
    return offsets.map((offset) => atm + offset * interval * dir)
  }

  const addN = () => {
    const wanted = strikesForPick(
      { mode: dir === 1 ? 'above' : 'below', count: nCount },
      atm,
      interval
    )
    addStrikes(wanted)
    setNOpen(false)
  }

  const addCustom = () => {
    const strike = Number(custom)
    if (!Number.isFinite(strike) || strike <= 0) return
    addStrikes([strike])
    setCustom('')
    setCustomOpen(false)
  }

  /* ── quick actions ─────────────────────────────────────────────────────── */
  const fire = useCallback(
    async (
      action: 'BUY' | 'SELL',
      side: 'CE' | 'PE',
      busyKey: keyof Busy,
      label: string
    ) => {
      const current = state.books[key]?.[side === 'CE' ? 'ce' : 'pe'] ?? []
      const plan = firingRows(current, state.lots)
      if (plan.length === 0) {
        showToast.warning(`${label}: no enabled ${side} rows`)
        return
      }
      setBusy((previous) => ({ ...previous, [busyKey]: true }))
      let placed = 0
      let failed = 0
      for (const { row, qty } of plan) {
        try {
          const res = await tradingApi.placeOrder({
            apikey: apiKey,
            strategy: 'DEPLOY',
            exchange: row.exchange,
            symbol: row.symbol,
            action,
            quantity: qty,
            pricetype: state.pricetype,
            product: state.product,
          })
          if (res.status === 'success') placed += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      setBusy((previous) => ({ ...previous, [busyKey]: false }))
      if (failed === 0) showToast.success(`${label}: ${placed} order${placed === 1 ? '' : 's'} placed`)
      else if (placed === 0) showToast.error(`${label}: every order failed`)
      else showToast.warning(`${label}: ${placed} placed, ${failed} failed`)
    },
    [apiKey, key, state]
  )

  const btn = (
    busyKey: keyof Busy,
    label: string,
    tone: 'green' | 'red' | 'amber',
    onClick: () => void
  ) => (
    <Button
      size="sm"
      disabled={busy[busyKey]}
      onClick={onClick}
      className={cn(
        'h-6 flex-1 px-1.5 text-[10px] font-medium',
        tone === 'green' && 'bg-emerald-600 text-white hover:bg-emerald-700',
        tone === 'red' && 'bg-red-600 text-white hover:bg-red-700',
        tone === 'amber' && 'bg-amber-500 text-white hover:bg-amber-600'
      )}
    >
      {busy[busyKey] && <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />}
      {label}
    </Button>
  )

  /* ── render ────────────────────────────────────────────────────────────── */
  return (
    <PanelShell
      id="oa-panel-deploy"
      label="Deploy"
      storageKey="oa-trading-deploy-width"
      defaultWidth={340}
    >
      {/* ── Header: identity + refresh ─────────────────────────────────── */}
      <div className={PANEL_HEADER}>
        <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold">Deploy</span>
        {underlying && (
          <span
            className="max-w-[90px] truncate rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-semibold"
            title={`${underlying} on ${optionsExchange}`}
          >
            {underlying}
          </span>
        )}
        <Select
          value={expiry}
          onValueChange={setExpiry}
          disabled={expiries.length === 0}
        >
          <SelectTrigger className="ml-auto h-6 w-[110px] px-1.5 text-[10px]">
            <SelectValue placeholder="Expiry" />
          </SelectTrigger>
          <SelectContent className="text-[11px]">
            {expiries.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title="Refresh chain"
          onClick={() => void loadChain()}
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {/* ── Quick actions ────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          {btn('deployCE', 'Deploy CE', 'green', () => void fire('BUY', 'CE', 'deployCE', 'Deploy CE'))}
          {btn('deployPE', 'Deploy PE', 'green', () => void fire('BUY', 'PE', 'deployPE', 'Deploy PE'))}
          {btn('closeCE', 'Close CE', 'red', () => void fire('SELL', 'CE', 'closeCE', 'Close CE'))}
          {btn('closePE', 'Close PE', 'red', () => void fire('SELL', 'PE', 'closePE', 'Close PE'))}
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">Batch</span>
          <Input
            type="number"
            min={1}
            value={state.lots}
            onChange={(e) => {
              const lots = Math.max(1, Math.floor(Number(e.target.value) || 1))
              save({ ...state, lots })
            }}
            className="h-5 w-12 px-1 text-[10px]"
            title="Lots per row (rows with their own lots override)"
          />
          <span className="text-muted-foreground">lots ·</span>
          <Select
            value={state.product}
            onValueChange={(product) => save({ ...state, product: product as DeployBook['product'] })}
          >
            <SelectTrigger className="h-5 w-[64px] px-1 text-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="text-[11px]">
              {(['MIS', 'NRML', 'CNC'] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={state.pricetype}
            onValueChange={(pricetype) =>
              save({ ...state, pricetype: pricetype as DeployBook['pricetype'] })
            }
          >
            <SelectTrigger className="h-5 w-[70px] px-1 text-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="text-[11px]">
              {(['MARKET', 'LIMIT', 'SL', 'SL-M'] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Add strip: the hedging panel's ladder, plus the N picker ────── */}
      <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <div className="flex overflow-hidden rounded border">
          {(['CE', 'PE'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSide(value)}
              className={cn(
                'px-2 py-0.5 text-[10px] font-semibold transition-colors',
                side === value
                  ? value === 'CE'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-red-600 text-white'
                  : 'bg-background text-muted-foreground hover:bg-accent'
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-1.5 text-[10px]"
          disabled={!atm}
          onClick={() => addStrikes([atm as number])}
          title="Add ATM strike"
        >
          ATM
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-5 w-5 px-0 text-[10px] font-bold"
          onClick={() => setDir((value) => (value === 1 ? -1 : 1))}
          title={`Offsets go ${dir === 1 ? 'above' : 'below'} ATM`}
        >
          {dir === 1 ? '+' : '−'}
        </Button>
        {OFFSET_BUTTONS.map((offset) => (
          <Button
            key={offset}
            size="sm"
            variant="outline"
            className="h-5 min-w-5 px-1 text-[10px]"
            disabled={!atm || !interval}
            onClick={() => addStrikes(offsetStrikes([offset]))}
            title={`Add ATM ${dir === 1 ? '+' : '−'}${offset}`}
          >
            {offset}
          </Button>
        ))}
        {/* N strikes at once: the IndexDeployDialog's ladder, one popover. */}
        <Popover open={nOpen} onOpenChange={setNOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-5 px-1.5 text-[10px] font-semibold"
              disabled={!atm || !interval}
              title="Add N strikes from ATM"
            >
              ×N
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-2" align="end">
            <p className="mb-1 text-[10px] text-muted-foreground">
              {nCount} strikes {dir === 1 ? 'above' : 'below'} ATM
            </p>
            <Input
              autoFocus
              type="number"
              min={1}
              max={10}
              value={nCount}
              onChange={(e) =>
                setNCount(Math.min(10, Math.max(1, Math.floor(Number(e.target.value) || 1))))
              }
              className="h-7 text-xs"
            />
            <Button size="sm" className="mt-1 h-6 w-full text-[11px]" onClick={addN}>
              Add {nCount} strike{nCount === 1 ? '' : 's'}
            </Button>
          </PopoverContent>
        </Popover>
        <Popover open={customOpen} onOpenChange={setCustomOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-5 px-1"
              title="Custom strike"
            >
              <CirclePlus className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-40 p-2" align="end">
            <Input
              autoFocus
              type="number"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustom()}
              placeholder="Strike…"
              className="h-7 text-xs"
            />
            <Button size="sm" className="mt-1 h-6 w-full text-[11px]" onClick={addCustom}>
              Add strike
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      {chainError && (
        <div className="border-b bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          {chainError}
        </div>
      )}
      {!atm && underlying && !chainError && (
        <div className="border-b bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
          Waiting for {underlying}'s chain snapshot — the ATM and offset picks land with it. The{' '}
          <CirclePlus className="inline h-2.5 w-2.5" /> button adds any strike by hand meanwhile.
        </div>
      )}

      {/* ── Rows ────────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <p className="p-3 text-center text-[11px] text-muted-foreground">
            {underlying
              ? 'Add strikes from ATM above, then fire them with Deploy.'
              : 'Chart an underlying with options to build a ladder.'}
          </p>
        )}
        {rows.map((row) => (
          <StrikeRow
            key={row.symbol}
            row={row}
            ltp={chainLtp(chain, row.symbol)}
            accent={strikeAccent(side, atm != null && interval ? (row.strike - atm) / interval : null)}
            onToggle={() =>
              patchRows(
                side,
                rows.map((r) => (r.symbol === row.symbol ? { ...r, enabled: !r.enabled } : r))
              )
            }
            onLots={(lots) =>
              patchRows(
                side,
                rows.map((r) => (r.symbol === row.symbol ? { ...r, lots } : r))
              )
            }
            onRemove={() => patchRows(side, rows.filter((r) => r.symbol !== row.symbol))}
            onFire={(action) => {
              const busyKey: keyof Busy =
                action === 'BUY'
                  ? side === 'CE'
                    ? 'deployCE'
                    : 'deployPE'
                  : side === 'CE'
                    ? 'closeCE'
                    : 'closePE'
              void fire(action, side, busyKey, `${action} ${row.strike}${side}`)
            }}
          />
        ))}
      </div>
    </PanelShell>
  )
}

/* ── One row ──────────────────────────────────────────────────────────────── */

function StrikeRow(props: {
  row: DeployRow
  ltp?: number
  accent: string | null
  onToggle(): void
  onLots(lots: number): void
  onRemove(): void
  onFire(action: 'BUY' | 'SELL'): void
}) {
  const { row } = props
  const [lotsOpen, setLotsOpen] = useState(false)
  const qty = (row.lots || 0) * row.lotSize
  return (
    <div
      className={cn(
        'flex items-center gap-1 border-b px-2 py-1',
        !row.enabled && 'opacity-50'
      )}
      style={{ borderLeft: `2px solid ${props.accent ?? 'transparent'}` }}
    >
      <input
        type="checkbox"
        checked={row.enabled}
        onChange={props.onToggle}
        className="h-3 w-3"
        aria-label={`Enable ${row.symbol}`}
      />
      <span
        className="w-14 font-mono text-[11px] tabular-nums"
        title={`${row.strike} ${row.optionType}`}
      >
        {row.strike}
        {row.optionType}
      </span>
      <span
        className={cn(
          'w-12 text-right font-mono text-[11px] tabular-nums',
          props.ltp == null && 'text-muted-foreground'
        )}
        title={row.symbol}
      >
        {props.ltp != null ? props.ltp.toFixed(2) : '—'}
      </span>
      <span className="w-10 font-mono text-[10px] tabular-nums text-muted-foreground" title="Quantity">
        {qty > 0 ? qty : `${row.lotSize}/lot`}
      </span>
      <Popover open={lotsOpen} onOpenChange={setLotsOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-8 px-0 font-mono text-[10px]"
            title="Lots for this row (0 = batch lots)"
          >
            {row.lots || 'B'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-32 p-2" align="end">
          <Input
            autoFocus
            type="number"
            min={0}
            value={row.lots}
            onChange={(e) => props.onLots(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="h-7 text-xs"
          />
          <p className="mt-1 text-[9px] text-muted-foreground">0 = use the batch lots</p>
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        className="ml-auto h-5 bg-emerald-600 px-1.5 text-[10px] text-white hover:bg-emerald-700"
        onClick={() => props.onFire('BUY')}
        title={`Buy ${row.symbol}`}
      >
        B
      </Button>
      <Button
        size="sm"
        className="h-5 bg-red-600 px-1.5 text-[10px] text-white hover:bg-red-700"
        onClick={() => props.onFire('SELL')}
        title={`Sell ${row.symbol}`}
      >
        S
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 w-5 px-0 text-muted-foreground"
        onClick={props.onRemove}
        title="Remove strike"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}
