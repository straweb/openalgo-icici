import { ChartLine, Loader2, RefreshCcw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type SymbolData, useMarketData } from '@/hooks/useMarketData'
import {
  type Contribution,
  constituentsFor,
  contributionLedger,
  type IndexProfile,
  weightedIndexMove,
} from '@/lib/hedging/indexConstituents'
import { cn } from '@/lib/utils'

/**
 * The dock's Index tab: the selected FNO index taken apart into its
 * constituents, live.
 *
 * Every stock of the index (Nifty 50, Bank Nifty, Sensex 30, Fin Nifty —
 * the static profiles in lib/hedging/indexConstituents) shows its current
 * price, traded volume and its % change since the session open (0% is the
 * open, per the spec). A filter box above the table narrows the list while
 * the quotes keep running. The contribution bubble pack shows, per stock,
 * how much of the index's move it explains (weight × move); clicking a
 * circle opens the donut — the same contribution ledger drawn as slices,
 * with each stock's numbers beside it. Clicking a row opens the stock's
 * own detail popup. A chart icon on each row loads that stock straight
 * into the focused chart pane — the same quick action the side panels
 * carry.
 *
 * The 1m series behind the row sparkline accumulates in this tab only while
 * it is open; the % reference itself is the day open, so a reopened tab
 * still reads the session correctly and just rebuilds its 1m history. The
 * old combined 1m studies (the stacked per-minute volume and the weighted
 * %/min trail) are gone: the volume half moved onto the index chart itself,
 * rebuilt there from the same members (lib/trading/indexVolume), where it
 * belongs at every timeframe.
 */

/** Maximum minute buckets kept for the row sparkline. */
const MAX_MINUTES = 24

const STOCK_COLORS = [
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#a3a3a3',
]

const fmt = (value: number, digits = 2) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const fmtPct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

const fmtVol = (value: number) => {
  const abs = Math.abs(value)
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return value.toFixed(0)
}

interface MinuteSeries {
  /** Per-minute % change snapshots (session-open referenced). */
  points: number[]
  lastBucket: number
  firstLtp: number
}

export interface IndexPanelProps {
  /** The FNO underlying whose constituents are shown (e.g. NIFTY). */
  underlying: string
  /** The spot index symbol to quote, from the chain snapshot. */
  indexSpot: { symbol: string; exchange: string } | null
  onLoadChart(pick: { symbol: string; exchange: string; name?: string }): void
}

/** One live row of the constituents table. */
interface StockRow {
  symbol: string
  weight: number
  ltp: number | undefined
  pct: number
  volume: number | undefined
  points: Contribution
  /** 1m % change snapshots since session open. */
  spark: number[]
}

/** Columns the constituent table sorts on; weight (index order) is the default. */
type ConstituentSort = 'weight' | 'symbol' | 'ltp' | 'pct' | 'volume' | 'contrib' | 'share'

export function IndexPanel(props: IndexPanelProps) {
  const profile = constituentsFor(props.underlying)
  if (!profile) {
    return <IndexEmpty underlying={props.underlying} />
  }
  return <IndexLive profile={profile} {...props} />
}

function IndexEmpty(props: { underlying: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
      <p className="text-[11px] text-muted-foreground">
        No constituent set for <span className="font-mono">{props.underlying}</span>.
      </p>
      <p className="text-[10px] text-muted-foreground">
        Index detail covers NIFTY, BANKNIFTY, SENSEX and FINNIFTY — pick one of those underlyings to
        break the index into its stocks.
      </p>
    </div>
  )
}

/** The live tab for an index with a constituent profile. */
function IndexLive(props: IndexPanelProps & { profile: IndexProfile }) {
  const { profile } = props
  const [tick, setTick] = useState(0)
  const [detail, setDetail] = useState<StockRow | null>(null)
  /** The donut's focused stock: the circle that was clicked, or null when shut. */
  const [donut, setDonut] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<ConstituentSort>('weight')
  const [sortDir, setSortDir] = useState<1 | -1>(1)
  /** The filter box above the table: a symbol substring, case-insensitive. */
  const [query, setQuery] = useState('')

  // Quote everything at once: the constituents + the index spot itself, in
  // Quote mode so volumes and opens ride along with the LTPs.
  const quoteSymbols = useMemo(() => {
    const list = profile.constituents.map((row) => ({
      symbol: row.symbol,
      exchange: profile.stockExchange,
    }))
    if (props.indexSpot) list.push(props.indexSpot)
    return list
  }, [profile, props.indexSpot])

  const { data: quotes, isConnected } = useMarketData({ symbols: quoteSymbols, mode: 'Quote' })

  // ── 1m accumulators ──────────────────────────────────────────────────────
  const seriesRef = useRef(new Map<string, MinuteSeries>())
  const quotesRef = useRef(quotes)
  quotesRef.current = quotes

  useEffect(() => {
    const timer = window.setInterval(() => {
      const bucket = Math.floor(Date.now() / 60000)
      for (const row of profile.constituents) {
        const quote = quotesRef.current.get(`${profile.stockExchange}:${row.symbol}`)?.data
        let series = seriesRef.current.get(row.symbol)
        if (!series) {
          series = { points: [], lastBucket: bucket, firstLtp: 0 }
          seriesRef.current.set(row.symbol, series)
        }
        const ltp = quote?.ltp ?? 0
        if (ltp > 0 && series.firstLtp === 0) series.firstLtp = ltp
        if (bucket !== series.lastBucket) {
          // A new minute closed: snapshot % change for the sparkline.
          const reference = sessionReference(quote, series.firstLtp)
          series.points.push(reference ? ((ltp - reference) / reference) * 100 : 0)
          if (series.points.length > MAX_MINUTES) series.points.shift()
          series.lastBucket = bucket
        }
      }
      setTick((value) => value + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [profile])

  // ── Derived rows ─────────────────────────────────────────────────────────
  const pctBySymbol = useMemo(() => {
    // `tick` re-derives at minute boundaries even without fresh quotes.
    void tick
    const map = new Map<string, number>()
    for (const row of profile.constituents) {
      const quote = quotes.get(`${profile.stockExchange}:${row.symbol}`)?.data
      const series = seriesRef.current.get(row.symbol)
      map.set(row.symbol, sessionPct(quote, series?.firstLtp ?? 0))
    }
    return map
  }, [profile, quotes, tick])

  const ledger = useMemo(() => contributionLedger(profile, pctBySymbol), [profile, pctBySymbol])

  const rows: StockRow[] = useMemo(
    () =>
      profile.constituents.map((row) => {
        const quote = quotes.get(`${profile.stockExchange}:${row.symbol}`)?.data
        const series = seriesRef.current.get(row.symbol)
        return {
          symbol: row.symbol,
          weight: row.weight,
          ltp: quote?.ltp,
          pct: pctBySymbol.get(row.symbol) ?? 0,
          volume: quote?.volume,
          points: ledger.find((entry) => entry.symbol === row.symbol) ?? {
            symbol: row.symbol,
            pctChange: 0,
            points: 0,
            share: 0,
          },
          spark: series?.points ?? [],
        }
      }),
    [profile, quotes, pctBySymbol, ledger]
  )

  const spotQuote = props.indexSpot
    ? quotes.get(`${props.indexSpot.exchange}:${props.indexSpot.symbol}`)?.data
    : undefined
  const spotPct = spotQuote ? sessionPct(spotQuote, 0) : weightedIndexMove(profile, pctBySymbol)
  const spotLtp = spotQuote?.ltp

  const byVolume = useMemo(
    () => [...rows].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)),
    [rows]
  )
  const colorOf = useCallback(
    (symbol: string) => {
      const index = byVolume.findIndex((row) => row.symbol === symbol)
      return STOCK_COLORS[(index < 0 ? 0 : index) % STOCK_COLORS.length]
    },
    [byVolume]
  )

  /** The rows in the table's current sort — a click on a header flips it. */
  const sortedRows = useMemo(() => {
    const value = (row: StockRow): number | string => {
      switch (sortKey) {
        case 'weight':
          return row.weight
        case 'symbol':
          return row.symbol
        case 'ltp':
          return row.ltp ?? 0
        case 'pct':
          return row.pct
        case 'volume':
          return row.volume ?? 0
        case 'contrib':
          return row.points.points
        case 'share':
          return row.points.share
      }
    }
    return [...rows].sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const cmp =
        typeof va === 'string' || typeof vb === 'string'
          ? String(va).localeCompare(String(vb))
          : (va as number) - (vb as number)
      return cmp * sortDir
    })
  }, [rows, sortKey, sortDir])

  const sortBy = (key: ConstituentSort) => {
    if (key === sortKey) setSortDir((dir) => (dir === 1 ? -1 : 1))
    else {
      setSortKey(key)
      // Numbers read best biggest-first; names, A→Z.
      setSortDir(key === 'symbol' ? 1 : -1)
    }
  }

  /** The filter's case-insensitive symbol substring, trimmed. */
  const needle = query.trim().toUpperCase()
  const visibleRows = needle ? sortedRows.filter((row) => row.symbol.includes(needle)) : sortedRows

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-stretch gap-2 border-b px-1.5 py-1">
        {/* Spot line + the contribution pack, one band. The combined 1m studies
            that used to sit under the spot line are gone — their volume half
            now lives on the index chart itself, rebuilt from these same
            members (lib/trading/indexVolume), where it reads at every
            timeframe instead of only after a minute closes. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold">{profile.label}</span>
            <span className="font-mono text-[11px] tabular-nums">
              {spotLtp ? fmt(spotLtp) : '—'}
            </span>
            <span
              className={cn(
                'font-mono text-[11px] tabular-nums',
                spotPct >= 0 ? 'text-emerald-500' : 'text-red-500'
              )}
              title={
                spotQuote ? 'Since session open' : 'Weighted estimate — spot quote unavailable'
              }
            >
              {fmtPct(spotPct)}
              {!spotQuote && ' est'}
            </span>
            <span className="text-[9px] text-muted-foreground" title="Live quote subscriptions">
              {isConnected ? (
                <RefreshCcw className="h-2.5 w-2.5" />
              ) : (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              )}
              <span className="ml-1">{profile.constituents.length} stocks</span>
            </span>
          </div>
          {/* The filter: a substring over the symbol column, live while the
              quotes run. Sorted state and filter compose — a narrowed view
              keeps the trader's sort. */}
          <div className="flex items-center gap-1 rounded border bg-background/50 px-1.5 py-0.5">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter stocks…"
              aria-label="Filter constituents"
              className="h-5 w-full min-w-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear the filter"
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => setQuery('')}
              >
                ✕
              </button>
            )}
            <span className="shrink-0 text-[9px] text-muted-foreground">
              {visibleRows.length}/{rows.length}
            </span>
          </div>
        </div>

        {/* Contribution bubble pack — click a circle for the donut */}
        <ContributionBubbles rows={rows} onDonut={setDonut} />
      </div>

      {/* Constituents table — click a header to sort, click again to flip.
          The table owns the panel's one scroll: it stretches to everything
          below the header band, so the panel reads full height and only
          ever shows a scrollbar when the rows ask for one. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="text-[9px] uppercase tracking-wide text-muted-foreground">
              {(
                [
                  ['symbol', 'Stock', 'left'],
                  ['ltp', 'LTP', 'right'],
                  ['pct', 'Chg%', 'right'],
                  [null, '1m %', 'left'],
                  ['volume', 'Volume', 'right'],
                  [null, 'Vol share', 'left'],
                  ['contrib', 'Contrib pt', 'right'],
                  ['share', 'Move%', 'right'],
                  ['weight', 'Wt%', 'left'],
                ] as const
              ).map(([key, label, align]) => (
                <th
                  key={label}
                  className={cn(
                    'cursor-pointer px-1 py-0.5 font-medium select-none hover:text-foreground',
                    align === 'right' ? 'text-right' : 'text-left'
                  )}
                  onClick={key ? () => sortBy(key) : undefined}
                  title={key ? `Sort by ${label}` : undefined}
                >
                  {label}
                  {key && sortKey === key && (
                    <span className="ml-0.5">{sortDir === 1 ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
              <th className="px-1 py-0.5" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <StockRowLine
                key={row.symbol}
                row={row}
                colorOf={colorOf}
                totalVolume={byVolume[0]?.volume ?? 0}
                onPick={() => setDetail(row)}
                onLoadChart={() =>
                  props.onLoadChart({ symbol: row.symbol, exchange: profile.stockExchange })
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      <StockDetailDialog row={detail} profile={profile} onClose={() => setDetail(null)} />
      <ContributionDonut
        rows={rows}
        profile={profile}
        focused={donut}
        onClose={() => setDonut(null)}
      />
    </div>
  )
}

/* ── Session reference / % helpers ───────────────────────────────────────── */

/**
 * The price the stock's session is measured from: the day open when the
 * feed carries it, else the first LTP this tab saw (documented fallback).
 */
function sessionReference(quote: SymbolData['data'] | undefined, firstLtp: number): number {
  if (quote?.open && quote.open > 0) return quote.open
  return firstLtp
}

function sessionPct(quote: SymbolData['data'] | undefined, firstLtp: number): number {
  const ltp = quote?.ltp ?? 0
  if (ltp <= 0) return 0
  const reference = sessionReference(quote, firstLtp)
  if (reference > 0) return ((ltp - reference) / reference) * 100
  // Last resort: the feed's own change%, referenced to the previous close.
  return quote?.change_percent ?? 0
}

/* ── One table row ───────────────────────────────────────────────────────── */

function StockRowLine(props: {
  row: StockRow
  colorOf(symbol: string): string
  totalVolume: number
  onPick(): void
  onLoadChart(): void
}) {
  const { row } = props
  const up = row.pct >= 0
  const volShare = props.totalVolume > 0 ? (row.volume ?? 0) / props.totalVolume : 0
  return (
    <tr className="border-t border-border/50 hover:bg-muted/40">
      <td className="px-1 py-0.5">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: props.colorOf(row.symbol) }}
          />
          <button
            type="button"
            className="max-w-[110px] truncate font-mono font-medium hover:underline"
            onClick={props.onPick}
            title={`${row.symbol} — open details`}
          >
            {row.symbol}
          </button>
        </span>
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">
        {row.ltp != null ? fmt(row.ltp) : '—'}
      </td>
      <td
        className={cn(
          'px-1 py-0.5 text-right font-mono tabular-nums font-semibold',
          up ? 'text-emerald-500' : 'text-red-500'
        )}
      >
        {row.ltp != null ? fmtPct(row.pct) : '—'}
      </td>
      <td className="px-1 py-0.5">
        <Sparkline points={row.spark} width={84} height={16} />
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">
        {row.volume != null ? fmtVol(row.volume) : '—'}
      </td>
      <td className="px-1 py-0.5">
        <span className="block h-1.5 w-16 overflow-hidden rounded bg-muted">
          <span
            className="block h-full rounded"
            style={{
              width: `${Math.min(100, volShare * 100)}%`,
              backgroundColor: props.colorOf(row.symbol),
            }}
          />
        </span>
      </td>
      <td
        className={cn(
          'px-1 py-0.5 text-right font-mono tabular-nums',
          row.points.points > 0 && 'text-emerald-500',
          row.points.points < 0 && 'text-red-500'
        )}
        title="Weight × move — points of index % this stock explains"
      >
        {row.points.points >= 0 ? '+' : ''}
        {row.points.points.toFixed(2)}
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums">
        {row.points.share >= 0 ? '+' : ''}
        {row.points.share.toFixed(0)}%
      </td>
      <td className="px-1 py-0.5 text-right font-mono tabular-nums text-muted-foreground">
        {row.weight.toFixed(1)}
      </td>
      <td className="px-1 py-0.5">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={props.onLoadChart}
          title={`Load ${row.symbol} into the selected chart`}
        >
          <ChartLine className="h-3 w-3" />
        </button>
      </td>
    </tr>
  )
}

/* ── Sparkline: 1m % series, 0% = session open ──────────────────────────── */

export function Sparkline(props: { points: number[]; width: number; height: number }) {
  const { points, width, height } = props
  if (points.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden>
        <line
          x1={1}
          y1={height / 2}
          x2={width - 1}
          y2={height / 2}
          stroke="currentColor"
          strokeDasharray="2 3"
          className="text-muted-foreground/40"
        />
      </svg>
    )
  }
  const series = points.length === 1 ? [points[0], points[0]] : points
  const min = Math.min(0, ...series)
  const max = Math.max(0, ...series)
  const span = max - min || 1
  const x = (index: number) => 2 + (index / (series.length - 1)) * (width - 4)
  const y = (value: number) => height - 2 - ((value - min) / span) * (height - 4)
  const path = series
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`)
    .join(' ')
  const last = points[points.length - 1]
  return (
    <svg width={width} height={height} aria-hidden>
      <line
        x1={1}
        y1={y(0)}
        x2={width - 1}
        y2={y(0)}
        stroke="currentColor"
        strokeDasharray="2 3"
        className="text-muted-foreground/40"
      />
      <path
        d={path}
        fill="none"
        strokeWidth={1.25}
        className={last >= 0 ? 'stroke-emerald-500' : 'stroke-red-500'}
      />
      <circle
        cx={x(series.length - 1)}
        cy={y(last)}
        r={1.75}
        className={last >= 0 ? 'fill-emerald-500' : 'fill-red-500'}
      />
    </svg>
  )
}

/* ── Who moves the index: the donut ─────────────────────────────────────── */

/**
 * The contribution ledger as a donut, opened by clicking a bubble.
 *
 * Slices are each stock's share of the index's absolute move — area, not
 * direction — and the fill says which way it pushed: green lifted, red
 * dragged. The centre carries the net. Beside the ring, every slice's own
 * numbers: the stock's move, the index points it explains, the share. The
 * circle that was clicked is outlined and first in the list, so the click
 * reads as an answer to "this one — how much of it was this stock?".
 */
function ContributionDonut(props: {
  rows: StockRow[]
  profile: IndexProfile
  focused: string | null
  onClose(): void
}) {
  const { focused } = props
  const slices = useMemo(() => {
    const live = props.rows
      .filter((row) => row.ltp != null && Math.abs(row.points.points) > 0)
      .sort((a, b) => Math.abs(b.points.points) - Math.abs(a.points.points))
    const total = live.reduce((sum, row) => sum + Math.abs(row.points.points), 0)
    if (total <= 0) return { slices: [], total: 0, net: 0 }
    const net = props.rows.reduce((sum, row) => sum + row.points.points, 0)
    // The focused circle leads, however small it is; the rest keep size order.
    const ordered = focused
      ? [
          ...live.filter((row) => row.symbol === focused),
          ...live.filter((row) => row.symbol !== focused),
        ]
      : live
    return { slices: ordered, total, net }
  }, [props.rows, focused])

  const netPct = weightedIndexMove(props.profile, new Map(props.rows.map((r) => [r.symbol, r.pct])))
  const R = 58
  const CX = 76
  const CY = 76
  let acc = -Math.PI / 2
  const arcs = slices.slices.slice(0, 10).map((row) => {
    const frac = Math.abs(row.points.points) / slices.total
    const start = acc
    const end = acc + frac * Math.PI * 2
    acc = end
    const large = end - start > Math.PI ? 1 : 0
    const p = (angle: number, radius: number) =>
      `${CX + Math.cos(angle) * radius},${CY + Math.sin(angle) * radius}`
    const d = `M${p(start, R)} A${R},${R} 0 ${large} 1 ${p(end, R)} L${CX},${CY} Z`
    return { row, d, frac }
  })

  return (
    <Dialog open={focused != null} onOpenChange={(value) => !value && props.onClose()}>
      <DialogContent className="max-w-sm p-4 text-xs">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Who moves {props.profile.label}
            {focused && <span className="font-mono"> — {focused}</span>}
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Slice area = share of the index's absolute move; green lifted it, red dragged it.
          </DialogDescription>
        </DialogHeader>
        {arcs.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted-foreground">
            Awaiting live quotes — the split lands with them.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <svg
              width={152}
              height={152}
              role="img"
              aria-label="Contribution donut"
              className="shrink-0"
            >
              {arcs.map(({ row, d }) => {
                const positive = row.points.points >= 0
                const isFocused = row.symbol === focused
                return (
                  <path
                    key={row.symbol}
                    d={d}
                    fill={positive ? '#10b981' : '#ef4444'}
                    fillOpacity={isFocused ? 0.85 : 0.45}
                    stroke={isFocused ? (positive ? '#047857' : '#b91c1c') : 'transparent'}
                    strokeWidth={isFocused ? 2 : 0}
                  >
                    <title>{`${row.symbol} · ${fmtPct(row.pct)} · ${row.points.points >= 0 ? '+' : ''}${row.points.points.toFixed(2)}pt · ${row.points.share >= 0 ? '+' : ''}${row.points.share.toFixed(0)}% of move`}</title>
                  </path>
                )
              })}
              <text
                x={CX}
                y={CY - 6}
                textAnchor="middle"
                fontSize={13}
                className="fill-foreground font-semibold"
              >
                {slices.net >= 0 ? '+' : ''}
                {slices.net.toFixed(2)}
              </text>
              <text
                x={CX}
                y={CY + 9}
                textAnchor="middle"
                fontSize={9}
                className="fill-muted-foreground"
              >
                net move pt
              </text>
              <text
                x={CX}
                y={CY + 22}
                textAnchor="middle"
                fontSize={9}
                className={netPct >= 0 ? 'fill-emerald-500' : 'fill-red-500'}
              >
                {fmtPct(netPct)}
              </text>
            </svg>
            <div className="min-w-0 flex-1">
              <table className="w-full border-collapse text-[10px]">
                <thead>
                  <tr className="text-[8px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-0.5 py-0.5 text-left font-medium">Stock</th>
                    <th className="px-0.5 py-0.5 text-right font-medium">Chg%</th>
                    <th className="px-0.5 py-0.5 text-right font-medium">Pt</th>
                    <th className="px-0.5 py-0.5 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {arcs.map(({ row }) => (
                    <tr key={row.symbol} className="border-t border-border/50">
                      <td className="px-0.5 py-0.5 font-mono font-medium">{row.symbol}</td>
                      <td
                        className={cn(
                          'px-0.5 py-0.5 text-right font-mono tabular-nums',
                          row.pct >= 0 ? 'text-emerald-500' : 'text-red-500'
                        )}
                      >
                        {fmtPct(row.pct)}
                      </td>
                      <td className="px-0.5 py-0.5 text-right font-mono tabular-nums">
                        {row.points.points >= 0 ? '+' : ''}
                        {row.points.points.toFixed(2)}
                      </td>
                      <td className="px-0.5 py-0.5 text-right font-mono tabular-nums">
                        {row.points.share >= 0 ? '+' : ''}
                        {row.points.share.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[9px] text-muted-foreground">
                Weights are indicative free-float figures; contribution = weight × stock move.
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ── Contribution bubble pack ────────────────────────────────────────────── */

function ContributionBubbles(props: { rows: StockRow[]; onDonut(symbol: string): void }) {
  const W = 210
  const H = 132
  const layout = useMemo(() => {
    const live = props.rows.filter((row) => row.ltp != null)
    const maxShare = Math.max(0, ...live.map((row) => Math.abs(row.points.share)))
    if (maxShare <= 0) return { circles: [], maxShare }
    const maxR = 17
    const minR = 4
    const packed: Array<{ row: StockRow; cx: number; cy: number; r: number }> = []
    const ordered = [...live].sort((a, b) => Math.abs(b.points.share) - Math.abs(a.points.share))
    for (const row of ordered) {
      const r = minR + Math.sqrt(Math.abs(row.points.share) / maxShare) * (maxR - minR)
      // Golden-angle spiral out from the centre; first spot with no overlap wins.
      let placed = { cx: W / 2, cy: H / 2 }
      for (let step = 0; step < 260; step++) {
        const angle = step * 2.399963
        const radius = 4 + step * 1.9
        const candidate = {
          cx: W / 2 + Math.cos(angle) * radius,
          cy: H / 2 + Math.sin(angle) * radius * 0.72,
        }
        if (
          candidate.cx - r < 2 ||
          candidate.cx + r > W - 2 ||
          candidate.cy - r < 2 ||
          candidate.cy + r > H - 2
        )
          continue
        const collides = packed.some(
          (other) =>
            Math.hypot(other.cx - candidate.cx, other.cy - candidate.cy) < other.r + r + 1.5
        )
        if (!collides) {
          placed = candidate
          break
        }
      }
      packed.push({ row, ...placed, r })
    }
    return { circles: packed, maxShare }
  }, [props.rows])

  const total = props.rows.reduce((sum, row) => sum + row.points.points, 0)

  return (
    <div className="w-[218px] shrink-0 rounded border px-1 pt-0.5">
      <span className="text-[8px] uppercase tracking-wide text-muted-foreground">
        Who moves the index — click a circle for the donut
      </span>
      {layout.circles.length === 0 ? (
        <div className="flex h-[118px] items-center justify-center text-[9px] text-muted-foreground">
          Awaiting live quotes…
        </div>
      ) : (
        <svg
          width={W - 4}
          height={H - 14}
          className="mt-0.5"
          role="img"
          aria-label="Contribution bubbles"
        >
          {layout.circles.map(({ row, cx, cy, r }) => {
            const positive = row.points.points >= 0
            return (
              <g
                key={row.symbol}
                onClick={() => props.onDonut(row.symbol)}
                className="cursor-pointer"
              >
                <title>
                  {`${row.symbol} ${fmtPct(row.pct)} · ${row.points.points >= 0 ? '+' : ''}${row.points.points.toFixed(2)}pt · ${row.points.share >= 0 ? '+' : ''}${row.points.share.toFixed(0)}% of move`}
                </title>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={positive ? '#10b981' : '#ef4444'}
                  fillOpacity={
                    0.25 + 0.55 * Math.min(1, Math.abs(row.points.share) / (layout.maxShare || 1))
                  }
                  stroke={positive ? '#059669' : '#dc2626'}
                  strokeWidth={1}
                />
                {r >= 9 && (
                  <text
                    x={cx}
                    y={cy + 2.5}
                    textAnchor="middle"
                    fontSize={7.5}
                    className="fill-foreground"
                    style={{ pointerEvents: 'none' }}
                  >
                    {row.symbol.slice(0, 8)}
                  </text>
                )}
              </g>
            )
          })}
          <text x={3} y={H - 18} fontSize={8} className="fill-muted-foreground">
            net move {total >= 0 ? '+' : ''}
            {total.toFixed(2)}pt · area = share
          </text>
        </svg>
      )}
    </div>
  )
}

/* ── Stock detail popup ──────────────────────────────────────────────────── */

function StockDetailDialog(props: {
  row: StockRow | null
  profile: IndexProfile
  onClose(): void
}) {
  const open = props.row != null
  const row = props.row
  return (
    <Dialog open={open} onOpenChange={(value) => !value && props.onClose()}>
      <DialogContent className="max-w-md p-4 text-xs">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-mono text-sm">
                {row.symbol}
                <span className="text-[10px] font-normal text-muted-foreground">
                  {props.profile.label} · {props.profile.stockExchange}
                </span>
              </DialogTitle>
              <DialogDescription className="text-[10px]">
                Live quote, session trail and index contribution.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-1.5">
              <DetailCell label="LTP" value={row.ltp != null ? fmt(row.ltp) : '—'} />
              <DetailCell
                label="Chg%"
                value={fmtPct(row.pct)}
                tone={row.pct >= 0 ? 'up' : 'down'}
              />
              <DetailCell label="Volume" value={row.volume != null ? fmtVol(row.volume) : '—'} />
              <DetailCell label="Index weight" value={`≈${row.weight.toFixed(2)}%`} />
              <DetailCell
                label="Contrib"
                value={`${row.points.points >= 0 ? '+' : ''}${row.points.points.toFixed(3)}pt`}
                tone={row.points.points >= 0 ? 'up' : 'down'}
              />
              <DetailCell
                label="Of move"
                value={`${row.points.share >= 0 ? '+' : ''}${row.points.share.toFixed(0)}%`}
                tone={row.points.share >= 0 ? 'up' : 'down'}
              />
            </div>
            <div className="mt-2 rounded border p-1">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                % since session open · 1m closes (0% = open)
              </span>
              <Sparkline points={row.spark} width={400} height={72} />
            </div>
            <p className="mt-1 text-[9px] text-muted-foreground">
              Weights are indicative free-float figures; contribution = weight × stock move.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailCell(props: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded border px-1.5 py-1">
      <span className="block text-[9px] text-muted-foreground">{props.label}</span>
      <span
        className={cn(
          'font-mono text-[11px] tabular-nums',
          props.tone === 'up' && 'text-emerald-500',
          props.tone === 'down' && 'text-red-500'
        )}
      >
        {props.value}
      </span>
    </div>
  )
}
