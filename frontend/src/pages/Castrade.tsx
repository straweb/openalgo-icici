import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  BadgeDollarSign,
  Ban,
  ChevronLeft,
  CircleDot,
  Clock,
  Crosshair,
  Flame,
  Link2,
  Play,
  RefreshCw,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import type {
  CastradeAnalysisData,
  CastradeCandle,
  CastradeEvent,
  CastradeLeg,
  CastradeUnderlying,
} from '@/api/castrade'
import { castradeApi } from '@/api/castrade'
import { useSocketContext } from '@/components/socket/SocketProvider'
import { AccountControls } from '@/components/layout/AccountControls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useThemeStore } from '@/stores/themeStore'

/**
 * The /castrade terminal - the cas_prediction expiry-day strategy as a page.
 *
 * Layout (like /trading and /hedging it is a full-width application surface
 * with its own toolbar band instead of the app navbar):
 *
 *   LEFT  : the charts - every strike of the 1 ITM + ATM + 6 OTM universe as
 *           a 1m candlestick chart, CE strikes in the left column, PE strikes
 *           in the right column (each column ordered ITM, ATM, then OTMs
 *           walking away from ATM). 15:19/15:20 pattern bars carry a dot
 *           marker on every chart; the winning leg gets BUY/SELL arrows.
 *   RIGHT : the strikes panel (CE rows, a CE/PE divider, PE rows) with each
 *           strike's score, verdict, pattern dots and projected/actual return;
 *           below it the final-trade panel - the ONE strike to buy at 15:21
 *           and sell at 15:29 - with LIVE BUY / SELL buttons that place real
 *           MARKET orders through the broker (live session only), plus the
 *           strategy's decision timeline.
 *
 * Two run modes:
 *   - REPLAY  (Analyze): the backend replays the cas_prediction timeline over
 *     one day of 1-minute candles. Read-only.
 *   - LIVE    (Go Live): a tick-by-tick session - broker feed ticks build the
 *     forming 1-minute bars, the engine re-runs on every tick (no waiting for
 *     the minute to close), updates arrive as `castrade_update` socket.io
 *     events (1.5s REST polling as a fallback), and the pick LOCKS the moment
 *     the decision bar closes. Only then are the BUY / SELL buttons armed,
 *     and they trade the locked pick only.
 */

const IST_OFFSET = 19800 // repo convention: bar times carry the IST shift

const UP = '#26a69a'
const DOWN = '#ef5350'
const FLAT = '#8a97a5'

const STORAGE_KEY = 'openalgo.castrade.v1'

interface PersistedConfig {
  underlying: string
  expiry: string
  tradeDate: string
  lots: number
  windowStart: string
  entryTime: string
  exitTime: string
  autoRefresh: boolean
}

function todayIst(): string {
  // The browser may sit in any timezone; the strategy runs on IST dates.
  // UTC epoch + 5h30m, read through the UTC fields via toISOString.
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
}

function loadConfig(): PersistedConfig {
  const fallback: PersistedConfig = {
    underlying: 'NIFTY',
    expiry: '',
    tradeDate: todayIst(),
    lots: 1,
    windowStart: '15:15',
    entryTime: '15:21',
    exitTime: '15:29',
    autoRefresh: false,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

function saveConfig(config: PersistedConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // storage unavailable (private mode) - the page still works, it just
    // will not remember the setup across reloads.
  }
}

/** Chart time (UTC seconds) of an IST clock time on a trade date. */
function istChartTime(tradeDate: string, hhmm: string): UTCTimestamp {
  const seconds = Math.floor(Date.parse(`${tradeDate}T${hhmm}:00+05:30`) / 1000)
  return (seconds + IST_OFFSET) as UTCTimestamp
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

function fmtPrice(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

function pctTone(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'text-muted-foreground'
  if (n > 0) return 'text-emerald-600 dark:text-emerald-400'
  if (n < 0) return 'text-red-600 dark:text-red-400'
  return 'text-muted-foreground'
}

const VERDICT_TONE: Record<string, string> = {
  'STRONG UP': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  UP: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  MIXED: 'bg-muted text-muted-foreground',
  DOWN: 'bg-red-500/10 text-red-600 dark:text-red-400',
  'STRONG DOWN': 'bg-red-500/15 text-red-600 dark:text-red-400',
}

function moneynessLabel(leg: Pick<CastradeLeg, 'moneyness' | 'otm_steps'>): string {
  if (leg.moneyness === 'ATM') return 'ATM'
  if (leg.moneyness === 'ITM') return 'ITM'
  return `OTM+${leg.otm_steps || ''}`.replace('+', '+')
}

function offsetLabel(leg: Pick<CastradeLeg, 'offset' | 'moneyness' | 'otm_steps'>): string {
  if (leg.moneyness) return moneynessLabel(leg)
  if (leg.offset === 0) return 'ATM'
  if (leg.offset < 0) return `ATM${leg.offset}`
  return `ATM+${leg.offset}`
}

// ---------------------------------------------------------------------------
// StrikeChart - one leg's 1m candlestick mini chart
// ---------------------------------------------------------------------------

function StrikeChart({
  leg,
  tradeDate,
  windowStart,
  patternBar,
  decisionBar,
  entryTime,
  exitTime,
  isWinner,
  isDark,
}: {
  leg: CastradeLeg
  tradeDate: string
  windowStart: string
  patternBar: string
  decisionBar: string
  entryTime: string
  exitTime: string
  isWinner: boolean
  isDark: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const candlesRef = useRef<CastradeCandle[]>(leg.candles)
  const lastAppliedRef = useRef<{ len: number; time: number } | null>(null)
  const [ready, setReady] = useState(false)
  candlesRef.current = leg.candles

  // Chart creation: keyed by the leg identity + theme + winner highlight, so
  // a live delta (new candles, new verdicts) NEVER rebuilds the chart - the
  // data/markers effects below stream updates into the existing series.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'
    const text = isDark ? '#9aa4b2' : '#5b6470'

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontSize: 9,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceLineColor: isWinner ? '#f59e0b' : grid,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    })
    seriesRef.current = series

    const sorted = [...candlesRef.current].sort((a, b) => a.time - b.time)
    series.setData(sorted as unknown as CandlestickData<Time>[])
    const last = sorted[sorted.length - 1]
    lastAppliedRef.current = last ? { len: sorted.length, time: Number(last.time) } : null

    markersRef.current = createSeriesMarkers(series, [])
    applyMarkers()

    // Focus the closing window (a little context before it).
    try {
      chart.timeScale().setVisibleRange({
        from: istChartTime(tradeDate, shiftMinutes(windowStart, -4)),
        to: istChartTime(tradeDate, '15:30'),
      })
    } catch {
      // empty day for this leg - nothing to range
    }
    setReady(true)

    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
      lastAppliedRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candles stream in via the update effect
  }, [leg.side, leg.strike, tradeDate, windowStart, entryTime, exitTime, isWinner, isDark])

  // Live data: fold the newest candle into the existing series (update()
  // replaces a bar at the same timestamp, so forming bars repaint in place).
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !ready) return
    const sorted = [...leg.candles].sort((a, b) => a.time - b.time)
    const last = sorted[sorted.length - 1]
    if (!last) return
    const applied = lastAppliedRef.current
    const next = { len: sorted.length, time: Number(last.time) }
    if (applied && applied.len === next.len && applied.time === next.time) return
    lastAppliedRef.current = next
    // Time went backwards (a new day/replay) -> full reset; otherwise stream.
    if (applied && Number(last.time) < applied.time) {
      series.setData(sorted as unknown as CandlestickData<Time>[])
    } else {
      series.update(last as unknown as CandlestickData<Time>)
    }
  }, [leg.candles, ready])

  // Pattern dots + winner arrows, refreshed as the live engine reclassifies.
  useEffect(() => {
    if (!ready) return
    applyMarkers()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild markers from the latest leg fields
  }, [leg.bar_pattern, leg.bar_decision, isWinner, ready, tradeDate, patternBar, decisionBar, entryTime, exitTime])

  function applyMarkers() {
    const markersApi = markersRef.current
    const series = seriesRef.current
    if (!markersApi || !series) return
    // Pattern dots on every chart: the 15:19 bar and the 15:20 bar, colored
    // by their own candle direction - this is the cross-side rule made
    // visible (red at near-ATM + greens on one side -> mirror strike wins).
    const markers: SeriesMarker<Time>[] = []
    const dot = (hhmm: string, color: string, text: string) => {
      markers.push({
        time: istChartTime(tradeDate, hhmm),
        position: 'aboveBar',
        color,
        shape: 'circle',
        text,
        size: 1,
      })
    }
    dot(patternBar, leg.bar_pattern ? colorFor(leg.bar_pattern.color) : FLAT, '19')
    dot(decisionBar, leg.bar_decision ? colorFor(leg.bar_decision.color) : FLAT, '20')

    if (isWinner) {
      markers.push({
        time: istChartTime(tradeDate, entryTime),
        position: 'belowBar',
        color: '#f59e0b',
        shape: 'arrowUp',
        text: 'BUY',
        size: 1,
      })
      markers.push({
        time: istChartTime(tradeDate, exitTime),
        position: 'aboveBar',
        color: '#64748b',
        shape: 'arrowDown',
        text: 'SELL',
        size: 1,
      })
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time))
    markersApi.setMarkers(markers as unknown as SeriesMarker<Time>[])
  }

  return (
    <div
      ref={containerRef}
      className={cn('h-[120px] w-full', !ready && 'opacity-0')}
      data-testid={`castrade-chart-${leg.side}-${leg.strike}`}
    />
  )
}

function colorFor(color: string): string {
  if (color === 'green') return UP
  if (color === 'red') return DOWN
  if (color === 'doji') return FLAT
  return FLAT
}

function shiftMinutes(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10))
  const total = h * 60 + m + delta
  const hh = Math.floor(total / 60) % 24
  const mm = ((total % 60) + 60) % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Strikes panel - CE rows, divider, PE rows
// ---------------------------------------------------------------------------

function StrikeRow({
  leg,
  isWinner,
  patternBar,
  decisionBar,
}: {
  leg: CastradeLeg
  isWinner: boolean
  patternBar: string
  decisionBar: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
        isWinner && 'bg-amber-500/10 ring-1 ring-amber-500/50',
        leg.blocked && 'opacity-55'
      )}
      data-testid={`castrade-row-${leg.side}-${leg.strike}`}
    >
      <span className="w-11 shrink-0 font-mono text-[10px] text-muted-foreground">
        {offsetLabel(leg)}
      </span>
      <span className="w-14 shrink-0 font-semibold tabular-nums">{fmtStrike(leg.strike)}</span>
      <span
        className="flex shrink-0 items-center gap-1"
        title={`${patternBar} / ${decisionBar} candles`}
      >
        <CircleDot
          className="h-3 w-3"
          style={{ color: colorFor(leg.bar_pattern?.color ?? 'none') }}
        />
        <CircleDot
          className="h-3 w-3"
          style={{ color: colorFor(leg.bar_decision?.color ?? 'none') }}
        />
      </span>
      <span
        className={cn(
          'w-12 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[10px]',
          VERDICT_TONE[leg.verdict] ?? 'bg-muted text-muted-foreground'
        )}
      >
        {leg.score > 0 ? '+' : ''}
        {leg.score.toFixed(2)}
      </span>
      <span className="flex-1 truncate text-right tabular-nums">
        {leg.premium_at_decision !== null ? fmtPrice(leg.premium_at_decision) : '—'}
      </span>
      <span
        className={cn(
          'w-14 shrink-0 text-right font-medium tabular-nums',
          pctTone(leg.projected_pct)
        )}
      >
        {fmtPct(leg.projected_pct)}
      </span>
      <span className={cn('w-14 shrink-0 text-right tabular-nums', pctTone(leg.actual?.pct))}>
        {fmtPct(leg.actual?.pct)}
      </span>
      {isWinner ? (
        <Badge variant="default" className="h-4 shrink-0 bg-amber-500 px-1 text-[9px] text-black">
          WIN
        </Badge>
      ) : leg.blocked ? (
        <Ban className="h-3.5 w-3.5 shrink-0 text-red-500" aria-label="Cond A banned" />
      ) : (
        <span className="w-[42px] shrink-0" />
      )}
    </div>
  )
}

function StrikesPanel({
  data,
  ceLegs,
  peLegs,
}: {
  data: CastradeAnalysisData
  ceLegs: CastradeLeg[]
  peLegs: CastradeLeg[]
}) {
  const winner = data.final_trade
  const isWinner = (leg: CastradeLeg) =>
    !!winner && winner.side === leg.side && winner.strike === leg.strike

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Target className="h-3.5 w-3.5" /> Strikes
        </h3>
        <div className="flex items-center gap-1 font-mono text-[10px]">
          <span className="text-emerald-600 dark:text-emerald-400">
            CE {data.votes.ce > 0 ? '+' : ''}
            {data.votes.ce.toFixed(2)}
          </span>
          <span className="text-muted-foreground">/</span>
          <span
            className={cn(
              data.votes.pe < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
            )}
          >
            PE {data.votes.pe > 0 ? '+' : ''}
            {data.votes.pe.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="px-1.5 py-1.5">
        {/* Column captions once, above the CE group */}
        <div className="flex items-center gap-2 px-2 pb-1 text-[9px] uppercase tracking-wide text-muted-foreground">
          <span className="w-11">Leg</span>
          <span className="w-14">Strike</span>
          <span className="w-8">19/20</span>
          <span className="w-12">Score</span>
          <span className="flex-1 text-right">Prem</span>
          <span className="w-14 text-right">Proj</span>
          <span className="w-14 text-right">Real</span>
          <span className="w-[42px]" />
        </div>

        <div className="rounded-md bg-emerald-500/5">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
              CE · CALLS
            </span>
            {data.cond_a.CE.banned && (
              <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                COND A −{data.cond_a.CE.drop_pct.toFixed(0)}%
              </Badge>
            )}
          </div>
          {ceLegs.map((leg) => (
            <StrikeRow
              key={leg.symbol}
              leg={leg}
              isWinner={isWinner(leg)}
              patternBar={data.window.pattern_bar}
              decisionBar={data.window.decision_bar}
            />
          ))}
        </div>

        {/* The CE | PE divider */}
        <div className="my-1.5 flex items-center gap-2 px-2">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[9px] font-bold tracking-widest text-muted-foreground">
            CE ▲ | PE ▼
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="rounded-md bg-red-500/5">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-bold tracking-wider text-red-600 dark:text-red-400">
              PE · PUTS
            </span>
            {data.cond_a.PE.banned && (
              <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                COND A −{data.cond_a.PE.drop_pct.toFixed(0)}%
              </Badge>
            )}
          </div>
          {peLegs.map((leg) => (
            <StrikeRow
              key={leg.symbol}
              leg={leg}
              isWinner={isWinner(leg)}
              patternBar={data.window.pattern_bar}
              decisionBar={data.window.decision_bar}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Final trade panel - the ONE strike to buy and sell (+ live order buttons)
// ---------------------------------------------------------------------------

function FinalTradePanel({
  data,
  lots,
  onLotsChange,
  onOrder,
  orderBusy,
}: {
  data: CastradeAnalysisData
  lots: number
  onLotsChange: (n: number) => void
  onOrder: (action: 'BUY' | 'SELL') => void
  orderBusy: boolean
}) {
  const trade = data.final_trade
  const isLive = !!data.live
  const locked = !!data.pick_locked
  const positionQty = data.position_qty ?? 0
  const lastOrder = data.orders?.[data.orders.length - 1]

  if (!trade && data.preview_pick) {
    // The engine is running on forming bars but the decision bar has not
    // closed yet - show the forming pick without arming any buttons.
    return (
      <div className="rounded-lg border bg-card ring-1 ring-amber-500/30">
        <PanelHeader />
        <div className="space-y-2 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold tabular-nums">
                {fmtStrike(data.preview_pick.strike)}
              </span>
              <Badge
                className={cn(
                  'px-1.5 font-bold',
                  data.preview_pick.side === 'CE'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-red-500/15 text-red-600 dark:text-red-400'
                )}
              >
                {data.preview_pick.side}
              </Badge>
            </div>
            <Badge className="bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              <Flame className="mr-0.5 h-3 w-3" />
              FORMING
            </Badge>
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            <Link2 className="mr-1 inline h-3 w-3" />
            {data.preview_pick.symbol}
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Tick-by-tick preview of the{' '}
            {data.preview_pick.source === 'pattern' ? 'cross-side pattern' : 'scoring'} pick — it
            LOCKS when the {data.window.decision_bar} bar closes and the BUY button arms for{' '}
            {data.window.entry}.
          </p>
          <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground/80">
            {data.preview_reason}
          </p>
        </div>
      </div>
    )
  }

  if (!trade) {
    return (
      <div className="rounded-lg border bg-card">
        <PanelHeader />
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Ban className="h-4 w-4 shrink-0 text-red-500" />
          <span>
            <span className="font-semibold text-foreground">NO TRADE</span>
            {data.no_trade_reason ? ` — ${data.no_trade_reason}` : ''}
          </span>
        </div>
      </div>
    )
  }

  const qty = Math.max(1, Math.round(trade.lot_size || data.lot_size || 1)) * lots
  const pnl = trade.pnl_per_unit !== null ? trade.pnl_per_unit * qty : null
  const canBuy = isLive && locked && positionQty === 0
  const canSell = isLive && locked && positionQty > 0

  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        trade.source === 'pattern' ? 'ring-1 ring-amber-500/40' : ''
      )}
      data-testid="castrade-final-trade"
    >
      <PanelHeader />
      <div className="space-y-2.5 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold tabular-nums">{fmtStrike(trade.strike)}</span>
            <Badge
              className={cn(
                'px-1.5 font-bold',
                trade.side === 'CE'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-red-500/15 text-red-600 dark:text-red-400'
              )}
            >
              {trade.side}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            {trade.source === 'pattern' && (
              <Badge className="bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                <Flame className="mr-0.5 h-3 w-3" /> PATTERN
              </Badge>
            )}
            {trade.source === 'scoring' && (
              <Badge variant="secondary" className="px-1.5 text-[10px]">
                SCORING
              </Badge>
            )}
            {trade.pending && (
              <Badge variant="outline" className="px-1.5 text-[10px]">
                PENDING
              </Badge>
            )}
          </div>
        </div>

        <div className="truncate font-mono text-[10px] text-muted-foreground" title={trade.symbol}>
          <Link2 className="mr-1 inline h-3 w-3" />
          {trade.symbol}
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border bg-emerald-500/5 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
              BUY @ {trade.entry_time}
            </div>
            <div className="font-semibold tabular-nums">{fmtPrice(trade.entry_price)}</div>
          </div>
          <div className="rounded-md border bg-slate-500/5 px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
              SELL @ {trade.exit_time}
            </div>
            <div className="font-semibold tabular-nums">{fmtPrice(trade.exit_price)}</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="px-1">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Return</div>
            <div className={cn('font-semibold tabular-nums', pctTone(trade.pct))}>
              {fmtPct(trade.pct)}
            </div>
          </div>
          <div className="px-1">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Qty</div>
            <div className="font-semibold tabular-nums">
              {qty}{' '}
              <span className="text-[9px] text-muted-foreground">
                ({trade.lot_size}×{lots})
              </span>
            </div>
          </div>
          <div className="px-1">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">P&L</div>
            <div className={cn('font-semibold tabular-nums', pctTone(trade.pnl_per_unit))}>
              {pnl !== null ? `₹${pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
            </div>
          </div>
        </div>

        {/* LIVE order buttons - the final strike's BUY (15:21) and SELL (15:29) */}
        <div className="grid grid-cols-2 gap-2 border-t pt-2">
          <Button
            size="sm"
            className="h-9 gap-1 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-600/90"
            disabled={!canBuy || orderBusy}
            onClick={() => onOrder('BUY')}
            data-testid="castrade-buy-btn"
          >
            BUY @ {data.window.entry}
          </Button>
          <Button
            size="sm"
            className="h-9 gap-1 bg-red-600 text-xs font-bold text-white hover:bg-red-600/90"
            disabled={!canSell || orderBusy}
            onClick={() => onOrder('SELL')}
            data-testid="castrade-sell-btn"
          >
            SELL @ {data.window.exit}
          </Button>
        </div>
        {!isLive && (
          <p className="text-[9px] leading-snug text-muted-foreground">
            Replay mode - orders are disabled. Press <span className="font-semibold">Go Live</span>{' '}
            to arm the BUY / SELL buttons for the real broker.
          </p>
        )}
        {isLive && !locked && (
          <p className="text-[9px] leading-snug text-muted-foreground">
            Buttons arm the moment the {data.window.decision_bar} bar closes and the pick locks.
          </p>
        )}
        {positionQty > 0 && (
          <p className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
            Open position: {positionQty} qty — press SELL to exit.
          </p>
        )}
        {lastOrder && (
          <p
            className={cn(
              'truncate text-[9px]',
              lastOrder.status === 'success'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            )}
            title={lastOrder.message || ''}
          >
            {lastOrder.time} {lastOrder.action} {lastOrder.quantity} qty{' '}
            {lastOrder.status === 'success'
              ? `ok${lastOrder.orderid ? ` · #${lastOrder.orderid}` : ''}`
              : `FAILED${lastOrder.message ? ` · ${lastOrder.message}` : ''}`}
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t pt-2">
          <p className="line-clamp-2 flex-1 text-[10px] leading-snug text-muted-foreground">
            {trade.reason}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-6 w-6 px-0"
              onClick={() => onLotsChange(Math.max(1, lots - 1))}
              aria-label="Decrease lots"
            >
              −
            </Button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{lots}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 w-6 px-0"
              onClick={() => onLotsChange(Math.min(20, lots + 1))}
              aria-label="Increase lots"
            >
              +
            </Button>
            <span className="text-[9px] text-muted-foreground">lots</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function PanelHeader() {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <BadgeDollarSign className="h-3.5 w-3.5" /> Final Trade
      </h3>
      <span className="font-mono text-[9px] text-muted-foreground">cas_prediction</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline events
// ---------------------------------------------------------------------------

function EventsList({ events }: { events: CastradeEvent[] }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Timeline
        </h3>
      </div>
      <ol className="space-y-1.5 px-3 py-2">
        {events.map((ev, i) => (
          <li key={`${ev.time}-${i}`} className="flex gap-2 text-[11px] leading-snug">
            <span className="w-10 shrink-0 font-mono text-muted-foreground">{ev.time}</span>
            <span className="flex-1 text-foreground/90">{ev.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart card - header + StrikeChart
// ---------------------------------------------------------------------------

function LegChartCard({
  leg,
  data,
  isWinner,
  isDark,
}: {
  leg: CastradeLeg
  data: CastradeAnalysisData
  isWinner: boolean
  isDark: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        isWinner && 'border-amber-500/60 shadow-[0_0_0_1px_rgba(245,158,11,0.4)]'
      )}
    >
      <div className="flex items-center justify-between gap-1 px-2.5 pb-1 pt-1.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-semibold tabular-nums">{fmtStrike(leg.strike)}</span>
          <span
            className={cn(
              'text-[9px] font-bold',
              leg.side === 'CE'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-red-600 dark:text-red-400'
            )}
          >
            {leg.side}
          </span>
          <span className="text-[9px] text-muted-foreground">{offsetLabel(leg)}</span>
        </div>
        <div className="flex items-center gap-1">
          {leg.flip && (
            <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">
              Flip
            </Badge>
          )}
          {leg.blocked && (
            <Badge variant="destructive" className="h-4 px-1 text-[8px]">
              Cond A
            </Badge>
          )}
          <span
            className={cn(
              'rounded px-1 py-0.5 font-mono text-[9px]',
              VERDICT_TONE[leg.verdict] ?? 'bg-muted text-muted-foreground'
            )}
          >
            {leg.verdict}
          </span>
          <span className={cn('w-11 text-right font-mono text-[9px]', pctTone(leg.actual?.pct))}>
            {fmtPct(leg.actual?.pct)}
          </span>
        </div>
      </div>
      <StrikeChart
        leg={leg}
        tradeDate={data.trade_date}
        windowStart={data.window.start}
        patternBar={data.window.pattern_bar}
        decisionBar={data.window.decision_bar}
        entryTime={data.window.entry}
        exitTime={data.window.exit}
        isWinner={isWinner}
        isDark={isDark}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live delta merge - fold a `castrade_update` payload into the page state
// ---------------------------------------------------------------------------

function mergeLiveDelta(prev: CastradeAnalysisData, delta: CastradeAnalysisData): CastradeAnalysisData {
  if (delta.type !== 'delta' || delta.legs[0]?.candles) {
    // Full snapshot (or an unexpected full payload) - replace wholesale.
    return { ...delta, type: undefined }
  }
  const byKey = new Map(prev.legs.map((l) => [`${l.side}|${l.strike}`, l]))
  const merged = prev.legs.map((leg) => {
    const d = delta.legs.find((x) => x.side === leg.side && x.strike === leg.strike)
    if (!d) return leg
    let candles = leg.candles
    const lc = d.last_candle
    if (lc) {
      const lastTime = candles.length ? candles[candles.length - 1].time : undefined
      if (lastTime === lc.time) {
        candles = [...candles.slice(0, -1), lc]
      } else if (lastTime === undefined || lc.time > (lastTime as number)) {
        candles = [...candles, lc]
        if (candles.length > 450) candles = candles.slice(candles.length - 450)
      }
    }
    return { ...leg, ...d, candles }
  })
  // Legs that became tradable after the snapshot (rare) get appended.
  for (const d of delta.legs) {
    if (!byKey.has(`${d.side}|${d.strike}`)) merged.push({ ...d, candles: d.last_candle ? [d.last_candle] : [] })
  }
  return { ...prev, ...delta, legs: merged, type: undefined }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function Castrade() {
  const { mode } = useThemeStore()
  const isDark = mode === 'dark'
  const { socket } = useSocketContext()

  const [config, setConfig] = useState<PersistedConfig>(() => loadConfig())
  const [underlyings, setUnderlyings] = useState<CastradeUnderlying[]>([])
  const [expiries, setExpiries] = useState<string[]>([])
  const [data, setData] = useState<CastradeAnalysisData | null>(null)
  const [loading, setLoading] = useState(false)
  const [liveBusy, setLiveBusy] = useState(false)
  const [orderBusy, setOrderBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)
  const analyzingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    saveConfig(config)
  }, [config])

  // One-time bootstrap: underlyings -> expiries -> (user presses Analyze).
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await castradeApi.getUnderlyings()
        if (!alive) return
        if (res.status === 'success' && res.data) setUnderlyings(res.data)
      } catch {
        // The dropdown falls back to the persisted underlying; analyze will
        // surface a proper error if the session really is not usable.
      } finally {
        if (alive) setBootstrapped(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Refresh the expiry list whenever the underlying changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload expiries only when the underlying changes; underlyings is a one-time boot list
  useEffect(() => {
    if (!config.underlying) return
    let alive = true
    ;(async () => {
      const fo = underlyings.find((u) => u.underlying === config.underlying)?.fo_exchange || 'NFO'
      try {
        const res = await castradeApi.getExpiry(config.underlying, fo)
        if (!alive) return
        if (res.status === 'success' && res.data) {
          setExpiries(res.data)
          setConfig((c) => ({
            ...c,
            expiry: res.data && res.data.length > 0 ? c.expiry || res.data[0] : '',
          }))
        }
      } catch {
        if (alive) setExpiries([])
      }
    })()
    return () => {
      alive = false
    }
  }, [config.underlying])

  const analyze = useCallback(async () => {
    if (analyzingRef.current) return
    if (!config.underlying || !config.expiry) return
    analyzingRef.current = true
    setLoading(true)
    setError(null)
    const fo = underlyings.find((u) => u.underlying === config.underlying)?.fo_exchange || 'NFO'
    try {
      const res = await castradeApi.analyze({
        underlying: config.underlying,
        exchange: fo,
        expiry: config.expiry,
        trade_date: config.tradeDate,
        window_start: config.windowStart,
        entry_time: config.entryTime,
        exit_time: config.exitTime,
      })
      if (res.status === 'success' && res.data) {
        setData(res.data)
      } else {
        setError(res.message || 'Analysis failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      analyzingRef.current = false
      setLoading(false)
    }
  }, [config, underlyings])

  // ---------------- LIVE tick-by-tick session ----------------

  const goLive = useCallback(async () => {
    if (!config.underlying || !config.expiry) return
    setLiveBusy(true)
    setError(null)
    const fo = underlyings.find((u) => u.underlying === config.underlying)?.fo_exchange || 'NFO'
    try {
      const res = await castradeApi.liveStart({
        underlying: config.underlying,
        exchange: fo,
        expiry: config.expiry,
        trade_date: config.tradeDate,
        window_start: config.windowStart,
        entry_time: config.entryTime,
        exit_time: config.exitTime,
      })
      if (res.status === 'success' && res.data) {
        sessionIdRef.current = res.data.session_id ?? null
        setData(res.data)
        toast.success('Live session started', {
          description: `${config.underlying} ${config.expiry} - ${res.data.feed?.symbols ?? 0} symbols subscribed for ticks`,
        })
      } else {
        setError(res.message || 'Live session failed to start')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Live session failed to start')
    } finally {
      setLiveBusy(false)
    }
  }, [config, underlyings])

  const stopLive = useCallback(async () => {
    setLiveBusy(true)
    try {
      await castradeApi.liveStop()
      sessionIdRef.current = null
      setData((d) => (d ? { ...d, live: false, phase: 'done' } : d))
      toast.info('Live session stopped')
    } catch {
      // the session may already be gone - treat as stopped
      sessionIdRef.current = null
      setData((d) => (d ? { ...d, live: false } : d))
    } finally {
      setLiveBusy(false)
    }
  }, [])

  // Socket.io deltas: the engine pushes after every tick pass.
  useEffect(() => {
    if (!socket) return
    const handler = (payload: { status?: string; data?: CastradeAnalysisData }) => {
      const sid = sessionIdRef.current
      if (!sid || !payload?.data || payload.data.session_id !== sid) return
      setData((prev) => (prev ? mergeLiveDelta(prev, payload.data as CastradeAnalysisData) : prev))
    }
    socket.on('castrade_update', handler)
    return () => {
      socket.off('castrade_update', handler)
    }
  }, [socket])

  // REST fallback (also a keep-alive while the tab is hidden to socket.io):
  // a slow 5s poll reconciles the page with the engine state.
  useEffect(() => {
    if (!data?.live || !sessionIdRef.current) return
    const id = setInterval(async () => {
      const sid = sessionIdRef.current
      if (!sid) return
      try {
        const res = await castradeApi.liveState(false)
        if (res.status === 'success' && res.data && res.data.session_id === sid) {
          setData((prev) => (prev ? mergeLiveDelta(prev, res.data as CastradeAnalysisData) : prev))
        }
      } catch {
        // session may have expired server-side - stop polling
        sessionIdRef.current = null
      }
    }, 5000)
    return () => clearInterval(id)
  }, [data?.live, data?.session_id])

  const placeOrder = useCallback(
    async (action: 'BUY' | 'SELL') => {
      const trade = data?.final_trade
      if (!trade) return
      const qty = Math.max(1, Math.round(trade.lot_size || data?.lot_size || 1)) * config.lots
      const ok = window.confirm(
        `${action} ${config.lots} lot(s) = ${qty} qty\n${trade.symbol}\nMARKET / MIS - place the real order?`
      )
      if (!ok) return
      setOrderBusy(true)
      try {
        const res = await castradeApi.placeOrder({
          action,
          symbol: trade.symbol,
          lots: config.lots,
          product: 'MIS',
        })
        if (res.status === 'success') {
          toast.success(`${action} order placed`, {
            description: `${trade.symbol} · qty ${qty}${res.orderid ? ` · ID ${res.orderid}` : ''}`,
          })
        } else {
          toast.error(`${action} rejected`, { description: res.message })
        }
      } catch (e) {
        const msg =
          (
            (e as { response?: { data?: { message?: string } } }).response?.data as
              | { message?: string }
              | undefined
          )?.message || (e instanceof Error ? e.message : 'Order failed')
        toast.error(`${action} failed`, { description: msg })
      } finally {
        setOrderBusy(false)
        // Refresh position/orders from the engine right away.
        try {
          const st = await castradeApi.liveState(false)
          if (st.status === 'success' && st.data) {
            setData((prev) => (prev ? mergeLiveDelta(prev, st.data as CastradeAnalysisData) : prev))
          }
        } catch {
          // ignore - the next delta/poll will reconcile
        }
      }
    },
    [data, config.lots]
  )

  // Live auto-refresh: only when the day is today's and the toggle is on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rearm only when the toggle or the analyzed day changes; analyze() identity is irrelevant to the interval
  useEffect(() => {
    if (config.autoRefresh && data && data.mode === 'live' && !data.live) {
      const id = setInterval(() => {
        analyze()
      }, 60_000)
      return () => clearInterval(id)
    }
  }, [config.autoRefresh, data?.mode, data?.live, data?.trade_date])

  const ceLegs = useMemo(
    () => (data?.legs ?? []).filter((l) => l.side === 'CE').sort((a, b) => a.offset - b.offset),
    [data]
  )
  // PE column mirrors the CE column: 1 ITM on top, then ATM, then the OTMs
  // walking away from the spot (descending strike = descending offset).
  const peLegs = useMemo(
    () => (data?.legs ?? []).filter((l) => l.side === 'PE').sort((a, b) => b.offset - a.offset),
    [data]
  )

  const winnerKey = data?.final_trade ? `${data.final_trade.side}-${data.final_trade.strike}` : ''

  if (!bootstrapped) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading CAS Trade…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Toolbar band (the terminal's chrome, like /trading and /hedging) */}
      <div className="oa-terminal-band flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <Link
          to="/dashboard"
          aria-label="Dashboard"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft /> <span className="hidden md:inline">Dashboard</span>
        </Link>
        <span className="mx-1 h-5 w-px bg-border" />
        <h1 className="hidden items-center gap-1.5 text-sm font-semibold sm:flex">
          <Crosshair className="h-4 w-4 text-amber-500" /> CAS Trade
        </h1>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

        <Select
          value={config.underlying}
          onValueChange={(v) => setConfig((c) => ({ ...c, underlying: v, expiry: '' }))}
        >
          <SelectTrigger size="sm" className="h-7 w-[130px] text-xs" aria-label="Underlying">
            <SelectValue placeholder="Underlying" />
          </SelectTrigger>
          <SelectContent>
            {(underlyings.length > 0
              ? underlyings.map((u) => u.underlying)
              : [config.underlying]
            ).map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={config.expiry}
          onValueChange={(v) => setConfig((c) => ({ ...c, expiry: v }))}
        >
          <SelectTrigger size="sm" className="h-7 w-[110px] text-xs" aria-label="Expiry">
            <SelectValue placeholder="Expiry" />
          </SelectTrigger>
          <SelectContent>
            {expiries.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={config.tradeDate}
          onChange={(e) => setConfig((c) => ({ ...c, tradeDate: e.target.value }))}
          className="h-7 w-[140px] text-xs"
          aria-label="Trade date"
        />

        <Button
          size="sm"
          className="h-7 gap-1.5 px-3 text-xs"
          onClick={analyze}
          disabled={loading || !config.expiry}
        >
          {loading ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Analyze
        </Button>

        {/* LIVE tick-by-tick session: subscribe the broker feed and stream. */}
        {data?.live ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-red-500/50 px-3 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
            onClick={stopLive}
            disabled={liveBusy}
          >
            <Square className="h-3.5 w-3.5" /> Stop Live
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 gap-1.5 bg-amber-500 px-3 text-xs font-semibold text-black hover:bg-amber-500/90"
            onClick={goLive}
            disabled={liveBusy || !config.expiry}
            title="Start the tick-by-tick live feed session (engine runs on every tick; the pick locks at the decision bar and the BUY/SELL buttons arm)"
          >
            {liveBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Go Live
          </Button>
        )}

        <div className="flex items-center gap-1.5 pl-1">
          <Switch
            id="castrade-auto"
            checked={config.autoRefresh}
            onCheckedChange={(v) => setConfig((c) => ({ ...c, autoRefresh: v }))}
            aria-label="Auto refresh in live mode"
          />
          <label
            htmlFor="castrade-auto"
            className="hidden text-[10px] text-muted-foreground lg:inline"
          >
            Auto 60s
          </label>
        </div>

        {data && (
          <Badge
            variant={data.mode === 'live' ? 'default' : 'secondary'}
            className={cn('ml-1 h-5 px-1.5 text-[9px]', data.mode === 'live' && 'bg-emerald-600')}
          >
            {data.live ? 'LIVE TICKS' : data.mode === 'live' ? 'LIVE' : 'REPLAY'}
          </Badge>
        )}

        {data?.live && data.feed && (
          <Badge
            variant={data.feed.connected ? 'default' : 'destructive'}
            className={cn(
              'h-5 px-1.5 font-mono text-[9px]',
              data.feed.connected ? 'bg-emerald-600' : ''
            )}
            title={
              data.feed.connected
                ? `Broker tick feed connected - ${data.feed.tick_count} ticks`
                : 'No ticks received - check that the broker websocket feed is connected'
            }
          >
            {data.feed.connected
              ? `FEED ${data.feed.tick_count.toLocaleString()} ticks`
              : 'FEED OFFLINE'}
          </Badge>
        )}

        <div className="flex-1" />
        {data && (
          <div className="mr-2 hidden items-center gap-3 font-mono text-[10px] text-muted-foreground xl:flex">
            <span>
              Spot {fmtPrice(data.spot.at_window_start)} → {fmtPrice(data.spot.at_decision)}
              {data.spot.projected_exit ? ` → ${fmtPrice(data.spot.projected_exit)}*` : ''}
            </span>
            <span>ATM {fmtStrike(data.atm)}</span>
            <span>Step {data.strike_step}</span>
            <span>Lot {data.lot_size}</span>
            {!data.is_expiry_day && (
              <Badge variant="outline" className="h-4 px-1 text-[8px] text-amber-600">
                NOT EXPIRY DAY
              </Badge>
            )}
          </div>
        )}
        <AccountControls variant="toolbar" />
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT - charts: CE column, PE column */}
        <main className="min-w-0 flex-1 overflow-y-auto p-2.5">
          {error && (
            <div
              role="alert"
              className="mb-2.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}

          {!data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Crosshair className="h-8 w-8 opacity-40" />
              <p>
                Pick an underlying, an expiry and a trade date, then press{' '}
                <span className="font-semibold text-foreground">Analyze</span> (replay) or{' '}
                <span className="font-semibold text-foreground">Go Live</span> (tick-by-tick).
              </p>
              <p className="max-w-md text-xs">
                The terminal runs the cas_prediction timeline — OHLC scoring over{' '}
                {config.windowStart}–{config.entryTime}, the {config.entryTime} buy /{' '}
                {config.exitTime} sell window, the 15:19/15:20 cross-side confirmation and the Cond
                A crash filter — on 1-minute candles of the 1 ITM + ATM + 6 OTM strikes per side
                (CE and PE), for any index or F&amp;O chart. Live mode re-runs the engine on every
                broker tick, locks the single final strike at {config.entryTime} and arms the real
                BUY / SELL order buttons.
              </p>
            </div>
          ) : (
            <>
              {/* Spot strip */}
              <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                <span>
                  {data.underlying} <span className="text-foreground/70">{data.expiry}</span>
                </span>
                <span>
                  window{' '}
                  <span className="text-foreground/70">
                    {data.window.start}–{data.window.decision_bar}
                  </span>
                </span>
                <span>
                  entry{' '}
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {data.window.entry}
                  </span>{' '}
                  → exit <span className="text-foreground/70">{data.window.exit}</span>
                </span>
                <span>
                  vote{' '}
                  <span
                    className={
                      data.votes.winning === 'CE' ? 'text-emerald-600 dark:text-emerald-400' : ''
                    }
                  >
                    CE {data.votes.ce > 0 ? '+' : ''}
                    {data.votes.ce.toFixed(2)}
                  </span>{' '}
                  /{' '}
                  <span className={data.votes.winning === 'PE' ? 'text-amber-600' : ''}>
                    PE {data.votes.pe > 0 ? '+' : ''}
                    {data.votes.pe.toFixed(2)}
                  </span>
                </span>
                <span>
                  pattern{' '}
                  <span
                    className={
                      data.pattern.found
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-foreground/70'
                    }
                  >
                    {data.pattern.found ? 'HIT' : 'miss'}
                  </span>
                </span>
                {data.live && (
                  <span>
                    phase{' '}
                    <span className="text-foreground/70">{data.phase ?? 'live'}</span>
                    {data.preview_pick && !data.pick_locked && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {' '}
                        · preview {data.preview_pick.side} {fmtStrike(data.preview_pick.strike)}
                      </span>
                    )}
                    {data.pick_locked && data.final_trade && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {' '}
                        · LOCKED {data.final_trade.side} {fmtStrike(data.final_trade.strike)}
                      </span>
                    )}
                  </span>
                )}
                <span className="flex-1" />
                <span>
                  <TrendingUp className="mr-0.5 inline h-3 w-3 text-emerald-500" />
                  CE basket {data.cond_a.CE.banned ? 'BANNED' : 'ok'}
                  {' · '}
                  <TrendingDown className="mr-0.5 inline h-3 w-3 text-red-500" />
                  PE basket {data.cond_a.PE.banned ? 'BANNED' : 'ok'}
                </span>
              </div>

              {/* CE charts column | PE charts column */}
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 md:gap-x-2.5">
                <section aria-label="CE strike charts">
                  <div className="mb-1.5 flex items-center gap-2 px-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
                      CE · CALLS
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {ceLegs.map((leg) => (
                      <LegChartCard
                        key={leg.symbol}
                        leg={leg}
                        data={data}
                        isWinner={`${leg.side}-${leg.strike}` === winnerKey}
                        isDark={isDark}
                      />
                    ))}
                  </div>
                </section>
                <section aria-label="PE strike charts">
                  <div className="mb-1.5 flex items-center gap-2 px-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-red-600 dark:text-red-400">
                      PE · PUTS
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="flex flex-col gap-2.5">
                    {peLegs.map((leg) => (
                      <LegChartCard
                        key={leg.symbol}
                        leg={leg}
                        data={data}
                        isWinner={`${leg.side}-${leg.strike}` === winnerKey}
                        isDark={isDark}
                      />
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}
        </main>

        {/* RIGHT - strikes panel + final trade + timeline */}
        <aside className="flex w-[380px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l p-2.5">
          {data ? (
            <>
              <StrikesPanel data={data} ceLegs={ceLegs} peLegs={peLegs} />
              <FinalTradePanel
                data={data}
                lots={config.lots}
                onLotsChange={(n) => setConfig((c) => ({ ...c, lots: n }))}
                onOrder={placeOrder}
                orderBusy={orderBusy}
              />
              <EventsList events={data.events} />
            </>
          ) : (
            <div className="rounded-lg border bg-card px-3 py-6 text-center text-xs text-muted-foreground">
              Run an analysis to see the strikes board and the final trade.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
