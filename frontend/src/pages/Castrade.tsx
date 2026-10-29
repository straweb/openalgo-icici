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
  Wallet,
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
import { AccountControls } from '@/components/layout/AccountControls'
import { useSocketContext } from '@/components/socket/SocketProvider'
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
 * Layout (compact, terminal-style):
 *
 *   LEFT  : TWO custom canvases - one for the CE side, one for the PE side.
 *           Each draws its representative leg's candles TICK BY TICK (the
 *           forming bar repaints in place from the live feed) and overlays
 *           the window markers (15:19 / 15:20 / entry / exit) plus the
 *           side's current PREDICTION - the strike the engine projects for a
 *           positive return. No more per-strike chart grids.
 *   RIGHT : resizable strikes panel (CE rows, a CE/PE divider, PE rows; each
 *           row has quick B/S buttons in live mode) + the Final Trade panel
 *           + the Funds-% slider + the timeline. Drag the divider to resize.
 *
 * Strike universe: SEVEN strikes on one shared ladder around the 15:15
 * baseline spot (3 below + ATM + 3 above), each strike with a CE and a PE
 * leg - 14 legs. Moneyness labels are per-side (CE ATM = strike at/below
 * spot, PE ATM = strike at/above spot). The cross-side mirror buys the
 * opposite side's own ATM: red 22750 CE -> buy 22800 PE, never 22750 PE.
 *
 * Live mode: broker feed ticks build the forming 1-minute bars, the engine
 * re-runs on every pass and pushes `castrade_update` socket.io events (5s
 * REST poll as fallback). The pick LOCKS when the decision bar closes and
 * the BUY / SELL buttons arm for the real broker.
 */

const IST_OFFSET = 19800 // repo convention: bar times carry the IST shift

const UP = '#26a69a'
const DOWN = '#ef5350'
const FLAT = '#8a97a5'
const GOLD = '#f59e0b'

const STORAGE_KEY = 'openalgo.castrade.v2' // v2: time inputs + panel width
const PANEL_W_KEY = 'openalgo.castrade.panelw'

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
    // Guard against stale/broken persisted times (e.g. exit before entry).
    const cfg = { ...fallback, ...parsed }
    const toMin = (t: string) => {
      const [h, m] = (t || '').split(':').map((v) => Number.parseInt(v, 10))
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1
    }
    if (toMin(cfg.exitTime) <= toMin(cfg.entryTime)) {
      cfg.windowStart = fallback.windowStart
      cfg.entryTime = fallback.entryTime
      cfg.exitTime = fallback.exitTime
    }
    return cfg
  } catch {
    return fallback
  }
}

function saveConfig(config: PersistedConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // storage unavailable (private mode) - the page still works
  }
}

/** Chart time (UTC seconds) of an IST clock time on a trade date. */
function istChartTime(tradeDate: string, hhmm: string): number {
  const seconds = Math.floor(Date.parse(`${tradeDate}T${hhmm}:00+05:30`) / 1000)
  return seconds + IST_OFFSET
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

function confidence20(score: number): number {
  // The 0..20 confidence read of a normalized score (-1..+1).
  return Math.max(0, Math.min(20, Math.round(((score + 1) / 2) * 20)))
}

function moneynessLabel(leg: Pick<CastradeLeg, 'moneyness' | 'otm_steps'>): string {
  if (leg.moneyness === 'ATM') return 'ATM'
  if (leg.moneyness === 'ITM') return 'ITM'
  return `OTM+${leg.otm_steps || ''}`
}

function offsetLabel(leg: Pick<CastradeLeg, 'offset' | 'moneyness' | 'otm_steps'>): string {
  if (leg.moneyness) return moneynessLabel(leg)
  if (leg.offset === 0) return 'ATM'
  if (leg.offset < 0) return `ATM${leg.offset}`
  return `ATM+${leg.offset}`
}

function colorFor(color: string): string {
  if (color === 'green') return UP
  if (color === 'red') return DOWN
  if (color === 'doji') return FLAT
  return FLAT
}

// ---------------------------------------------------------------------------
// Side prediction - the leg on this side the engine projects for a positive
// return (locked pick > forming preview > best projected leg > side ATM)
// ---------------------------------------------------------------------------

function pickRepresentativeLeg(
  data: CastradeAnalysisData,
  side: 'CE' | 'PE'
): CastradeLeg | undefined {
  const legs = data.legs.filter((l) => l.side === side)
  if (legs.length === 0) return undefined
  const byStrike = (s: number) => legs.find((l) => l.strike === s)
  if (data.final_trade?.side === side) {
    const l = byStrike(data.final_trade.strike)
    if (l) return l
  }
  if (data.preview_pick?.side === side) {
    const l = byStrike(data.preview_pick.strike)
    if (l) return l
  }
  const positive = legs
    .filter((l) => l.tradable && (l.projected_pct ?? 0) > 0 && l.candles.length > 0)
    .sort((a, b) => (b.projected_pct ?? 0) - (a.projected_pct ?? 0))
  if (positive[0]) return positive[0]
  return (
    legs.find((l) => l.moneyness === 'ATM' && l.candles.length > 0) ??
    legs.find((l) => l.candles.length > 0)
  )
}

// ---------------------------------------------------------------------------
// SideCanvas - the custom real-time candlestick canvas (one per side)
// ---------------------------------------------------------------------------

interface SideCanvasProps {
  leg: CastradeLeg | undefined
  predicted: CastradeLeg | undefined
  data: CastradeAnalysisData
  isDark: boolean
  height?: number
}

function SideCanvas({ leg, predicted, data, isDark, height = 200 }: SideCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const candlesRef = useRef<CastradeCandle[]>(leg?.candles ?? [])
  candlesRef.current = leg?.candles ?? []

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const w = wrap.clientWidth
    const h = height
    if (w <= 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const grid = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'
    const text = isDark ? '#9aa4b2' : '#5b6470'

    const padL = 4
    const padR = 54
    const padT = 10
    const padB = 6

    const all = [...candlesRef.current].sort((a, b) => a.time - b.time)
    const vis = all.slice(-90)
    const drawNoData = (msg: string) => {
      ctx.fillStyle = text
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(msg, w / 2, h / 2)
    }
    if (vis.length === 0) {
      drawNoData('waiting for candles — press Analyze or Go Live')
      return
    }

    let hi = -Infinity
    let lo = Infinity
    for (const c of vis) {
      if (c.high > hi) hi = c.high
      if (c.low < lo) lo = c.low
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) {
      hi = (hi || 0) + 1
      lo = (lo || 0) - 1
    }
    const range = hi - lo
    const top = hi + range * 0.08
    const bot = lo - range * 0.06
    const innerW = w - padL - padR
    const innerH = h - padT - padB
    const xw = innerW / vis.length
    const yOf = (p: number) => padT + ((top - p) / (top - bot)) * innerH

    // horizontal grid + price labels
    ctx.strokeStyle = grid
    ctx.fillStyle = text
    ctx.font = '9px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.lineWidth = 1
    const lines = 4
    for (let i = 0; i <= lines; i++) {
      const p = top - ((top - bot) * i) / lines
      const yy = Math.round(yOf(p)) + 0.5
      ctx.beginPath()
      ctx.moveTo(padL, yy)
      ctx.lineTo(w - padR, yy)
      ctx.stroke()
      ctx.fillText(fmtPrice(p), w - padR + 4, yy + 3)
    }

    // window markers: pattern 15:19, decision 15:20, entry, exit
    const marks: Array<[string, string, string]> = [
      [data.window.pattern_bar, GOLD, '19'],
      [data.window.decision_bar, GOLD, '20'],
      [data.window.entry, isDark ? '#34d399' : '#059669', 'E'],
      [data.window.exit, isDark ? '#94a3b8' : '#64748b', 'X'],
    ]
    const t0 = vis[0].time
    const t1 = vis[vis.length - 1].time
    ctx.textAlign = 'center'
    for (const [hhmm, color, label] of marks) {
      const tt = istChartTime(data.trade_date, hhmm)
      if (tt < t0 || tt > t1) continue
      const idx = vis.findIndex((c) => c.time >= tt)
      if (idx < 0) continue
      const x = Math.round(padL + idx * xw + xw / 2) + 0.5
      ctx.strokeStyle = color
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(x, padT)
      ctx.lineTo(x, h - padB)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.fillText(label, x, h - padB + 0.5 > h ? h - 2 : padT + 7)
    }

    // candles
    const bodyW = Math.max(1.5, Math.min(9, xw * 0.62))
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i]
      const cx = padL + i * xw + xw / 2
      const up = c.close >= c.open
      ctx.strokeStyle = up ? UP : DOWN
      ctx.fillStyle = up ? UP : DOWN
      ctx.lineWidth = 1
      // wick
      ctx.beginPath()
      ctx.moveTo(Math.round(cx) + 0.5, yOf(c.high))
      ctx.lineTo(Math.round(cx) + 0.5, yOf(c.low))
      ctx.stroke()
      // body
      const yHi = yOf(Math.max(c.open, c.close))
      const yLo = yOf(Math.min(c.open, c.close))
      const bh = Math.max(1, yLo - yHi)
      if (up) {
        ctx.fillRect(cx - bodyW / 2, yHi, bodyW, bh)
      } else {
        ctx.fillRect(cx - bodyW / 2, yHi, bodyW, bh)
      }
    }

    // last price line + right chip
    const last = vis[vis.length - 1]
    const ly = yOf(last.close)
    ctx.strokeStyle = GOLD
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(padL, ly)
    ctx.lineTo(w - padR, ly)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = GOLD
    ctx.fillRect(w - padR + 2, ly - 7, padR - 4, 14)
    ctx.fillStyle = '#1a1a1a'
    ctx.font = 'bold 9px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(fmtPrice(last.close), w - padR + 4, ly + 3)
  }, [data.trade_date, data.window, height, isDark])

  // biome-ignore lint/correctness/useExhaustiveDependencies: candlesRef is read inside draw(); the extra deps are the semantic redraw triggers (candle updates and leg switches)
  useEffect(() => {
    draw()
  }, [draw, leg?.candles, leg?.symbol, predicted?.symbol])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => draw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [draw])

  return (
    <div
      ref={wrapRef}
      className="w-full"
      style={{ height }}
      data-testid={`castrade-canvas-${leg?.side ?? 'na'}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Side chart card - header (side, vote, PREDICT chip) + SideCanvas
// ---------------------------------------------------------------------------

function SideChartCard({
  side,
  data,
  repLeg,
  predicted,
  isDark,
}: {
  side: 'CE' | 'PE'
  data: CastradeAnalysisData
  repLeg: CastradeLeg | undefined
  predicted: CastradeLeg | undefined
  isDark: boolean
}) {
  const isCE = side === 'CE'
  const vote = isCE ? data.votes.ce : data.votes.pe
  const condA = isCE ? data.cond_a.CE : data.cond_a.PE
  const winning = data.votes.winning === side
  return (
    <div
      className={cn('rounded-lg border bg-card', winning && 'ring-1 ring-amber-500/40')}
      data-testid={`castrade-side-card-${side}`}
    >
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-[10px] font-bold tracking-wider',
              isCE ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            )}
          >
            {side} · {isCE ? 'CALLS' : 'PUTS'}
          </span>
          {winning && (
            <Badge className="h-4 bg-amber-500 px-1 text-[8px] font-bold text-black">
              WIN SIDE
            </Badge>
          )}
          {condA.banned && (
            <Badge variant="destructive" className="h-4 px-1 text-[8px]">
              COND A −{condA.drop_pct.toFixed(0)}%
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className={pctTone(vote)}>
            vote {vote > 0 ? '+' : ''}
            {vote.toFixed(2)}
          </span>
          {predicted ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600 dark:text-amber-400"
              title={`predicted leg ${predicted.symbol} — projected ${fmtPct(predicted.projected_pct)}`}
              data-testid={`castrade-predict-${side}`}
            >
              PREDICT {fmtStrike(predicted.strike)} {fmtPct(predicted.projected_pct)}
            </span>
          ) : (
            <span className="text-muted-foreground">no positive-return strike yet</span>
          )}
        </div>
      </div>
      {repLeg && (
        <div className="flex items-center gap-2 px-2 pb-0.5 font-mono text-[9px] text-muted-foreground">
          <span className="text-foreground/70">
            {offsetLabel(repLeg)} {fmtStrike(repLeg.strike)}
          </span>
          <span
            className={cn(
              'rounded px-1 py-px',
              VERDICT_TONE[repLeg.verdict] ?? 'bg-muted text-muted-foreground'
            )}
          >
            {repLeg.verdict}
          </span>
          <span>{confidence20(repLeg.score)}/20</span>
          <span className={pctTone(repLeg.projected_pct)}>proj {fmtPct(repLeg.projected_pct)}</span>
          <span>prem {fmtPrice(repLeg.premium_live ?? repLeg.premium_at_decision)}</span>
          <span className="flex-1" />
          <span className="text-muted-foreground/70">
            19/20 dots{' '}
            <CircleDot
              className="inline h-2.5 w-2.5 align-baseline"
              style={{ color: colorFor(repLeg.bar_pattern?.color ?? 'none') }}
            />{' '}
            <CircleDot
              className="inline h-2.5 w-2.5 align-baseline"
              style={{ color: colorFor(repLeg.bar_decision?.color ?? 'none') }}
            />
          </span>
        </div>
      )}
      <SideCanvas leg={repLeg} predicted={predicted} data={data} isDark={isDark} height={196} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strikes panel - CE rows, divider, PE rows (+ quick B/S + PRED badges)
// ---------------------------------------------------------------------------

function StrikeRow({
  leg,
  isWinner,
  isPredicted,
  patternBar,
  decisionBar,
  live,
  onQuickOrder,
  positionQty,
}: {
  leg: CastradeLeg
  isWinner: boolean
  isPredicted: boolean
  patternBar: string
  decisionBar: string
  live: boolean
  onQuickOrder: (leg: CastradeLeg, action: 'BUY' | 'SELL') => void
  positionQty: number
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]',
        isWinner && 'bg-amber-500/10 ring-1 ring-amber-500/50',
        !isWinner && isPredicted && 'bg-amber-500/5',
        leg.blocked && 'opacity-55'
      )}
      data-testid={`castrade-row-${leg.side}-${leg.strike}`}
    >
      <span className="w-10 shrink-0 font-mono text-[9px] text-muted-foreground">
        {offsetLabel(leg)}
      </span>
      <span className="w-13 shrink-0 font-semibold tabular-nums">{fmtStrike(leg.strike)}</span>
      <span
        className="flex shrink-0 items-center gap-0.5"
        title={`${patternBar} / ${decisionBar} candles`}
      >
        <CircleDot
          className="h-2.5 w-2.5"
          style={{ color: colorFor(leg.bar_pattern?.color ?? 'none') }}
        />
        <CircleDot
          className="h-2.5 w-2.5"
          style={{ color: colorFor(leg.bar_decision?.color ?? 'none') }}
        />
      </span>
      <span
        className={cn(
          'w-10 shrink-0 rounded px-0.5 py-0.5 text-center font-mono text-[9px]',
          VERDICT_TONE[leg.verdict] ?? 'bg-muted text-muted-foreground'
        )}
        title={`score ${leg.score > 0 ? '+' : ''}${leg.score.toFixed(2)} (${leg.verdict})`}
      >
        {leg.score > 0 ? '+' : ''}
        {leg.score.toFixed(2)}
      </span>
      <span
        className={cn(
          'w-8 shrink-0 text-center font-mono text-[9px] tabular-nums',
          confidence20(leg.score) >= 15
            ? 'text-emerald-600 dark:text-emerald-400'
            : confidence20(leg.score) <= 5
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground'
        )}
        title="Confidence out of 20 (normalized window score)"
      >
        {confidence20(leg.score)}/20
      </span>
      <span className="flex-1 truncate text-right tabular-nums">
        {(leg.premium_live ?? leg.premium_at_decision !== null)
          ? fmtPrice(leg.premium_live ?? leg.premium_at_decision)
          : '—'}
      </span>
      <span
        className={cn(
          'w-12 shrink-0 text-right font-medium tabular-nums',
          pctTone(leg.projected_pct)
        )}
      >
        {fmtPct(leg.projected_pct)}
      </span>
      <span className={cn('w-12 shrink-0 text-right tabular-nums', pctTone(leg.actual?.pct))}>
        {fmtPct(leg.actual?.pct)}
      </span>
      {isWinner ? (
        <Badge variant="default" className="h-4 shrink-0 bg-amber-500 px-1 text-[8px] text-black">
          WIN
        </Badge>
      ) : isPredicted ? (
        <Badge
          variant="outline"
          className="h-4 shrink-0 border-amber-500/60 px-1 text-[8px] text-amber-600 dark:text-amber-400"
        >
          PRED
        </Badge>
      ) : leg.blocked ? (
        <Ban className="h-3 w-3 shrink-0 text-red-500" aria-label="Cond A banned" />
      ) : (
        <span className="w-[34px] shrink-0" />
      )}
      {live ? (
        <span className="flex shrink-0 items-center gap-0.5">
          {positionQty > 0 && (
            <span
              className="mr-0.5 rounded bg-amber-500/20 px-1 font-mono text-[8px] text-amber-600 dark:text-amber-400"
              title="Open qty from this page"
            >
              {positionQty}
            </span>
          )}
          <Button
            size="sm"
            className="h-4.5 w-5 rounded px-0 text-[8px] font-bold text-white bg-emerald-600 hover:bg-emerald-600/90"
            disabled={leg.blocked || !leg.tradable}
            onClick={() => onQuickOrder(leg, 'BUY')}
            aria-label={`Quick BUY ${leg.symbol}`}
            data-testid={`castrade-quick-buy-${leg.side}-${leg.strike}`}
          >
            B
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-4.5 w-5 rounded border-red-500/40 px-0 text-[8px] font-bold text-red-600 hover:bg-red-500/10 dark:text-red-400"
            disabled={positionQty <= 0}
            onClick={() => onQuickOrder(leg, 'SELL')}
            aria-label={`Quick SELL ${leg.symbol}`}
            data-testid={`castrade-quick-sell-${leg.side}-${leg.strike}`}
          >
            S
          </Button>
        </span>
      ) : (
        <span className="w-[44px] shrink-0" />
      )}
    </div>
  )
}

function StrikesPanel({
  data,
  ceLegs,
  peLegs,
  predictedKeys,
  onQuickOrder,
}: {
  data: CastradeAnalysisData
  ceLegs: CastradeLeg[]
  peLegs: CastradeLeg[]
  predictedKeys: Set<string>
  onQuickOrder: (leg: CastradeLeg, action: 'BUY' | 'SELL') => void
}) {
  const winner = data.final_trade
  const isWinner = (leg: CastradeLeg) =>
    !!winner && winner.side === leg.side && winner.strike === leg.strike
  const live = !!data.live
  const positions = data.positions ?? {}
  const posOf = (leg: CastradeLeg) => positions[leg.symbol] ?? 0

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <h3 className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Target className="h-3 w-3" /> Strikes
        </h3>
        <div className="flex items-center gap-1 font-mono text-[9px]">
          <span
            className={cn(
              data.votes.winning === 'CE'
                ? 'font-bold text-emerald-600 dark:text-emerald-400'
                : 'text-emerald-600/70 dark:text-emerald-400/70'
            )}
          >
            CE {data.votes.ce > 0 ? '+' : ''}
            {data.votes.ce.toFixed(2)}
          </span>
          <span className="text-muted-foreground">/</span>
          <span
            className={cn(
              data.votes.winning === 'PE' ? 'font-bold text-amber-600' : 'text-muted-foreground'
            )}
          >
            PE {data.votes.pe > 0 ? '+' : ''}
            {data.votes.pe.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="px-1 py-1">
        <div className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[8px] uppercase tracking-wide text-muted-foreground">
          <span className="w-10">Leg</span>
          <span className="w-13">Strike</span>
          <span className="w-6 text-center">19/20</span>
          <span className="w-10 text-center">Score</span>
          <span className="w-8 text-center">Conf</span>
          <span className="flex-1 text-right">Prem</span>
          <span className="w-12 text-right">Proj</span>
          <span className="w-12 text-right">Real</span>
          <span className="w-[34px]" />
          {live ? <span className="w-[44px] text-center">B/S</span> : <span className="w-[44px]" />}
        </div>

        <div className="rounded-md bg-emerald-500/5">
          <div className="flex items-center justify-between px-1.5 py-0.5">
            <span className="text-[9px] font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
              CE · CALLS
            </span>
            {data.cond_a.CE.banned && (
              <Badge variant="destructive" className="h-3.5 px-1 text-[8px]">
                COND A −{data.cond_a.CE.drop_pct.toFixed(0)}%
              </Badge>
            )}
          </div>
          {ceLegs.map((leg) => (
            <StrikeRow
              key={leg.symbol}
              leg={leg}
              isWinner={isWinner(leg)}
              isPredicted={predictedKeys.has(`${leg.side}-${leg.strike}`)}
              patternBar={data.window.pattern_bar}
              decisionBar={data.window.decision_bar}
              live={live}
              onQuickOrder={onQuickOrder}
              positionQty={posOf(leg)}
            />
          ))}
        </div>

        <div className="my-1 flex items-center gap-2 px-1.5">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[8px] font-bold tracking-widest text-muted-foreground">
            CE ▲ | PE ▼
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="rounded-md bg-red-500/5">
          <div className="flex items-center justify-between px-1.5 py-0.5">
            <span className="text-[9px] font-bold tracking-wider text-red-600 dark:text-red-400">
              PE · PUTS
            </span>
            {data.cond_a.PE.banned && (
              <Badge variant="destructive" className="h-3.5 px-1 text-[8px]">
                COND A −{data.cond_a.PE.drop_pct.toFixed(0)}%
              </Badge>
            )}
          </div>
          {peLegs.map((leg) => (
            <StrikeRow
              key={leg.symbol}
              leg={leg}
              isWinner={isWinner(leg)}
              isPredicted={predictedKeys.has(`${leg.side}-${leg.strike}`)}
              patternBar={data.window.pattern_bar}
              decisionBar={data.window.decision_bar}
              live={live}
              onQuickOrder={onQuickOrder}
              positionQty={posOf(leg)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Final trade panel + funds slider (compact)
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
    return (
      <div className="rounded-lg border bg-card ring-1 ring-amber-500/30">
        <PanelHeader />
        <div className="space-y-1.5 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-1.5">
              <span className="text-base font-bold tabular-nums">
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
            <Badge className="bg-amber-500/15 px-1.5 text-[9px] text-amber-600 dark:text-amber-400">
              <Flame className="mr-0.5 h-3 w-3" />
              FORMING
            </Badge>
          </div>
          <div className="truncate font-mono text-[9px] text-muted-foreground">
            <Link2 className="mr-1 inline h-2.5 w-2.5" />
            {data.preview_pick.symbol}
          </div>
          <p className="line-clamp-2 text-[9px] leading-snug text-muted-foreground/80">
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
        <div className="flex items-center gap-2 px-2.5 py-2.5 text-[11px] text-muted-foreground">
          <Ban className="h-3.5 w-3.5 shrink-0 text-red-500" />
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
      <div className="space-y-1.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold tabular-nums">{fmtStrike(trade.strike)}</span>
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
              <Badge className="bg-amber-500/15 px-1.5 text-[9px] text-amber-600 dark:text-amber-400">
                <Flame className="mr-0.5 h-3 w-3" /> PATTERN
              </Badge>
            )}
            {trade.source === 'scoring' && (
              <Badge variant="secondary" className="px-1.5 text-[9px]">
                SCORING
              </Badge>
            )}
            {trade.pending && (
              <Badge variant="outline" className="px-1.5 text-[9px]">
                PENDING
              </Badge>
            )}
          </div>
        </div>

        <div className="truncate font-mono text-[9px] text-muted-foreground" title={trade.symbol}>
          <Link2 className="mr-1 inline h-2.5 w-2.5" />
          {trade.symbol}
        </div>

        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
          <div className="rounded border bg-emerald-500/5 px-1.5 py-1">
            <div className="text-[8px] uppercase text-muted-foreground">BUY {trade.entry_time}</div>
            <div className="font-semibold tabular-nums">{fmtPrice(trade.entry_price)}</div>
          </div>
          <div className="rounded border bg-slate-500/5 px-1.5 py-1">
            <div className="text-[8px] uppercase text-muted-foreground">SELL {trade.exit_time}</div>
            <div className="font-semibold tabular-nums">{fmtPrice(trade.exit_price)}</div>
          </div>
          <div className="rounded border px-1.5 py-1">
            <div className="text-[8px] uppercase text-muted-foreground">Qty / P&L</div>
            <div className="font-semibold tabular-nums">
              {qty} ·{' '}
              <span className={pctTone(trade.pnl_per_unit)}>
                {pnl !== null
                  ? `₹${pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                  : '—'}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5 border-t pt-1.5">
          <Button
            size="sm"
            className="h-8 gap-1 bg-emerald-600 text-[11px] font-bold text-white hover:bg-emerald-600/90"
            disabled={!canBuy || orderBusy}
            onClick={() => onOrder('BUY')}
            data-testid="castrade-buy-btn"
          >
            BUY @ {data.window.entry}
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1 bg-red-600 text-[11px] font-bold text-white hover:bg-red-600/90"
            disabled={!canSell || orderBusy}
            onClick={() => onOrder('SELL')}
            data-testid="castrade-sell-btn"
          >
            SELL @ {data.window.exit}
          </Button>
        </div>
        {!isLive && (
          <p className="text-[8px] leading-snug text-muted-foreground">
            Replay mode - orders disabled. Press <span className="font-semibold">Go Live</span> to
            arm the BUY / SELL buttons for the real broker.
          </p>
        )}
        {isLive && !locked && (
          <p className="text-[8px] leading-snug text-muted-foreground">
            Buttons arm when the {data.window.decision_bar} bar closes and the pick locks.
          </p>
        )}
        {positionQty > 0 && (
          <p className="text-[9px] font-medium text-amber-600 dark:text-amber-400">
            Open position: {positionQty} qty — press SELL to exit.
          </p>
        )}
        {lastOrder && (
          <p
            className={cn(
              'truncate text-[8px]',
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

        <div className="flex items-center justify-between gap-2 border-t pt-1.5">
          <p className="line-clamp-2 flex-1 text-[9px] leading-snug text-muted-foreground">
            {trade.reason}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-5 w-5 px-0"
              onClick={() => onLotsChange(Math.max(1, lots - 1))}
              aria-label="Decrease lots"
            >
              −
            </Button>
            <span className="w-5 text-center font-mono text-[11px] tabular-nums">{lots}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-5 w-5 px-0"
              onClick={() => onLotsChange(Math.min(20, lots + 1))}
              aria-label="Increase lots"
            >
              +
            </Button>
            <span className="text-[8px] text-muted-foreground">lots</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function PanelHeader() {
  return (
    <div className="flex items-center justify-between border-b px-2.5 py-1.5">
      <h3 className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <BadgeDollarSign className="h-3 w-3" /> Final Trade
      </h3>
      <span className="font-mono text-[8px] text-muted-foreground">cas_prediction</span>
    </div>
  )
}

function FundsSlider({
  data,
  lots,
  onApplyLots,
}: {
  data: CastradeAnalysisData
  lots: number
  onApplyLots: (n: number) => void
}) {
  const [available, setAvailable] = useState<number | null>(null)
  const [pct, setPct] = useState(25)
  const [fetching, setFetching] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isLive = !!data.live

  const refresh = useCallback(async () => {
    setFetching(true)
    setErr(null)
    try {
      const res = await castradeApi.getFunds()
      if (res.status === 'success' && res.data) {
        setAvailable(res.data.available)
        if (res.data.available === null) setErr('Funds figure unavailable from the broker')
      } else {
        setErr(res.message || 'Funds unavailable')
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Funds unavailable')
    } finally {
      setFetching(false)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch when a new live session starts (session_id change)
  useEffect(() => {
    if (isLive) refresh()
  }, [isLive, data.session_id, refresh])

  const trade = data.final_trade
  const leg = trade
    ? data.legs.find((l) => l.side === trade.side && l.strike === trade.strike)
    : undefined
  const premium = leg?.premium_live ?? leg?.premium_at_decision ?? null
  const lotSize = trade?.lot_size || data.lot_size || 0
  const deployable = available !== null ? (available * pct) / 100 : null
  const suggestedLots =
    deployable !== null && premium && premium > 0 && lotSize > 0
      ? Math.max(0, Math.floor(deployable / (premium * lotSize)))
      : null
  const appliedLots = suggestedLots !== null ? Math.min(20, Math.max(1, suggestedLots)) : null

  return (
    <div className="rounded-lg border bg-card" data-testid="castrade-funds-slider">
      <div className="flex items-center justify-between border-b px-2.5 py-1.5">
        <h3 className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Wallet className="h-3 w-3" /> Funds %
        </h3>
        <div className="flex items-center gap-1.5">
          {available !== null && (
            <span className="font-mono text-[9px] tabular-nums text-muted-foreground">
              avail ₹{available.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-4 w-4 px-0"
            onClick={refresh}
            disabled={fetching || !isLive}
            aria-label="Refresh funds"
          >
            <RefreshCw className={cn('h-2.5 w-2.5', fetching && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <div className="space-y-1 px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => setPct(Number.parseInt(e.target.value, 10))}
            className="h-1 flex-1 cursor-pointer accent-amber-500"
            aria-label="Percent of available funds"
            data-testid="castrade-funds-range"
          />
          <span className="w-9 text-right font-mono text-[11px] font-semibold tabular-nums">
            {pct}%
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
          <span className="tabular-nums">
            {deployable !== null
              ? `≈ ₹${deployable.toLocaleString('en-IN', { maximumFractionDigits: 0 })} deployed`
              : isLive
                ? '—'
                : 'Go Live to fetch funds'}
          </span>
          <span className="tabular-nums">
            {suggestedLots !== null
              ? `≈ ${suggestedLots} lot${suggestedLots === 1 ? '' : 's'}${
                  premium ? ` @ ${fmtPrice(premium)}` : ''
                }`
              : ''}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[8px] leading-snug text-muted-foreground">
            Sizes the Lots stepper ({lots} now) for BUY/SELL + quick B/S.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-5 shrink-0 px-1.5 text-[9px]"
            disabled={appliedLots === null || appliedLots === lots}
            onClick={() => appliedLots !== null && onApplyLots(appliedLots)}
            data-testid="castrade-funds-apply"
          >
            Apply
          </Button>
        </div>
        {err && <p className="text-[8px] text-red-600 dark:text-red-400">{err}</p>}
      </div>
    </div>
  )
}

function EventsList({ events }: { events: CastradeEvent[] }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1 border-b px-2.5 py-1.5">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Timeline
        </h3>
      </div>
      <ol className="space-y-0.5 px-2.5 py-1.5">
        {events.map((ev, i) => (
          <li key={`${ev.time}-${i}`} className="flex gap-1.5 text-[10px] leading-snug">
            <span className="w-9 shrink-0 font-mono text-muted-foreground">{ev.time}</span>
            <span className="flex-1 text-foreground/90">{ev.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live delta merge - fold a `castrade_update` payload into the page state
// ---------------------------------------------------------------------------

function mergeLiveDelta(
  prev: CastradeAnalysisData,
  delta: CastradeAnalysisData
): CastradeAnalysisData {
  if (delta.type !== 'delta' || delta.legs[0]?.candles) {
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
  for (const d of delta.legs) {
    if (!byKey.has(`${d.side}|${d.strike}`))
      merged.push({ ...d, candles: d.last_candle ? [d.last_candle] : [] })
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
  const [panelW, setPanelW] = useState<number>(() => {
    const v = Number.parseInt(localStorage.getItem(PANEL_W_KEY) || '', 10)
    return Number.isFinite(v) && v >= 280 ? v : 340
  })
  const analyzingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    saveConfig(config)
  }, [config])

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_W_KEY, String(panelW))
    } catch {
      // ignore
    }
  }, [panelW])

  // Resizable right panel: drag the divider between the charts and the aside.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      e.preventDefault()
      const w = Math.min(720, Math.max(280, window.innerWidth - e.clientX - 4))
      setPanelW(w)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // One-time bootstrap: underlyings -> expiries -> (user presses Analyze).
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await castradeApi.getUnderlyings()
        if (!alive) return
        if (res.status === 'success' && res.data) setUnderlyings(res.data)
      } catch {
        // dropdown falls back to the persisted underlying
      } finally {
        if (alive) setBootstrapped(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Refresh the expiry list whenever the underlying changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload expiries only when the underlying changes
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

  const timesValid = useMemo(() => {
    const toMin = (t: string) => {
      const [h, m] = (t || '').split(':').map((v) => Number.parseInt(v, 10))
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1
    }
    return toMin(config.exitTime) > toMin(config.entryTime)
  }, [config.entryTime, config.exitTime])

  const analyze = useCallback(async () => {
    if (analyzingRef.current) return
    if (!config.underlying || !config.expiry) return
    if (!timesValid) {
      setError('Exit time must be after entry time — fix the times in the toolbar.')
      return
    }
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
  }, [config, underlyings, timesValid])

  // ---------------- LIVE tick-by-tick session ----------------

  const goLive = useCallback(async () => {
    if (!config.underlying || !config.expiry) return
    if (!timesValid) {
      setError('Exit time must be after entry time — fix the times in the toolbar.')
      return
    }
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
          description: `${config.underlying} ${config.expiry} - ${res.data.feed?.symbols ?? 0} symbols subscribed; updates stream on every tick`,
        })
      } else {
        setError(res.message || 'Live session failed to start')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Live session failed to start')
    } finally {
      setLiveBusy(false)
    }
  }, [config, underlyings, timesValid])

  const stopLive = useCallback(async () => {
    setLiveBusy(true)
    try {
      await castradeApi.liveStop()
      sessionIdRef.current = null
      setData((d) => (d ? { ...d, live: false, phase: 'done' } : d))
      toast.info('Live session stopped')
    } catch {
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

  // REST fallback (also a keep-alive while the tab is hidden from socket.io):
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
        sessionIdRef.current = null
      }
    }, 5000)
    return () => clearInterval(id)
  }, [data?.live, data?.session_id])

  const placeOrderFor = useCallback(
    async (action: 'BUY' | 'SELL', symbol: string, lotsCount: number) => {
      if (!symbol) return
      // Informational qty for the confirm dialog; the backend recomputes
      // quantity = lots x contract lot size from the master contract.
      const lotSize = data?.final_trade?.lot_size || data?.lot_size || 1
      const qty = Math.max(1, Math.round(lotSize)) * lotsCount
      const ok = window.confirm(
        `${action} ${lotsCount} lot(s) = ${qty} qty\n${symbol}\nMARKET / MIS - place the real order?`
      )
      if (!ok) return
      setOrderBusy(true)
      try {
        const res = await castradeApi.placeOrder({
          action,
          symbol,
          lots: lotsCount,
          product: 'MIS',
        })
        if (res.status === 'success') {
          toast.success(`${action} order placed`, {
            description: `${symbol} · qty ${qty}${res.orderid ? ` · ID ${res.orderid}` : ''}`,
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
    [data]
  )

  const placeOrder = useCallback(
    (action: 'BUY' | 'SELL') => {
      const trade = data?.final_trade
      if (!trade) return
      return placeOrderFor(action, trade.symbol, config.lots)
    },
    [data, config.lots, placeOrderFor]
  )

  const quickOrder = useCallback(
    (leg: CastradeLeg, action: 'BUY' | 'SELL') => {
      return placeOrderFor(action, leg.symbol, config.lots)
    },
    [config.lots, placeOrderFor]
  )

  // Live auto-refresh: only when the day is today's and the toggle is on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rearm only when the toggle or the analyzed day changes
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
  const peLegs = useMemo(
    () => (data?.legs ?? []).filter((l) => l.side === 'PE').sort((a, b) => b.offset - a.offset),
    [data]
  )

  const ceRep = useMemo(() => (data ? pickRepresentativeLeg(data, 'CE') : undefined), [data])
  const peRep = useMemo(() => (data ? pickRepresentativeLeg(data, 'PE') : undefined), [data])
  const predictedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const l of [ceRep, peRep]) {
      if (l) keys.add(`${l.side}-${l.strike}`)
    }
    return keys
  }, [ceRep, peRep])

  const winnerKey = data?.final_trade ? `${data.final_trade.side}-${data.final_trade.strike}` : ''
  void winnerKey

  if (!bootstrapped) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading CAS Trade…
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Toolbar band (compact) */}
      <div className="oa-terminal-band flex h-9 shrink-0 items-center gap-1 border-b px-1.5">
        <Link
          to="/dashboard"
          aria-label="Dashboard"
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft /> <span className="hidden md:inline">Dashboard</span>
        </Link>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <h1 className="hidden items-center gap-1 text-xs font-semibold sm:flex">
          <Crosshair className="h-3.5 w-3.5 text-amber-500" /> CAS Trade
        </h1>
        <span className="mx-0.5 hidden h-4 w-px bg-border sm:block" />

        <Select
          value={config.underlying}
          onValueChange={(v) => setConfig((c) => ({ ...c, underlying: v, expiry: '' }))}
        >
          <SelectTrigger size="sm" className="h-6 w-[110px] text-[11px]" aria-label="Underlying">
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
          <SelectTrigger size="sm" className="h-6 w-[96px] text-[11px]" aria-label="Expiry">
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
          className="h-6 w-[124px] text-[11px]"
          aria-label="Trade date"
        />

        {/* Window / entry / exit times - editable (exit before entry is rejected) */}
        <div
          className="flex items-center gap-0.5"
          title="Window start / entry (lock) / exit times (IST)"
        >
          <Input
            type="time"
            value={config.windowStart}
            onChange={(e) => setConfig((c) => ({ ...c, windowStart: e.target.value }))}
            className={cn('h-6 w-[84px] px-1 font-mono text-[10px]')}
            aria-label="Window start time"
          />
          <span className="text-[9px] text-muted-foreground">→</span>
          <Input
            type="time"
            value={config.entryTime}
            onChange={(e) => setConfig((c) => ({ ...c, entryTime: e.target.value }))}
            className="h-6 w-[84px] px-1 font-mono text-[10px]"
            aria-label="Entry time"
          />
          <span className="text-[9px] text-muted-foreground">→</span>
          <Input
            type="time"
            value={config.exitTime}
            onChange={(e) => setConfig((c) => ({ ...c, exitTime: e.target.value }))}
            className={cn(
              'h-6 w-[84px] px-1 font-mono text-[10px]',
              !timesValid && 'border-red-500/60 text-red-600'
            )}
            aria-label="Exit time"
          />
        </div>
        {!timesValid && (
          <Badge variant="destructive" className="h-4 px-1 text-[8px]">
            EXIT &lt;= ENTRY
          </Badge>
        )}

        <Button
          size="sm"
          className="h-6 gap-1 px-2.5 text-[11px]"
          onClick={analyze}
          disabled={loading || !config.expiry || !timesValid}
        >
          {loading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Analyze
        </Button>

        {data?.live ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 border-red-500/50 px-2.5 text-[11px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
            onClick={stopLive}
            disabled={liveBusy}
          >
            <Square className="h-3 w-3" /> Stop Live
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-6 gap-1 bg-amber-500 px-2.5 text-[11px] font-semibold text-black hover:bg-amber-500/90"
            onClick={goLive}
            disabled={liveBusy || !config.expiry || !timesValid}
            title="Start the tick-by-tick live feed session (engine runs on every tick; updates stream as socket events; the pick locks at the decision bar)"
          >
            {liveBusy ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Zap className="h-3 w-3" />
            )}
            Go Live
          </Button>
        )}

        <div className="flex items-center gap-1 pl-0.5">
          <Switch
            id="castrade-auto"
            checked={config.autoRefresh}
            onCheckedChange={(v) => setConfig((c) => ({ ...c, autoRefresh: v }))}
            aria-label="Auto refresh in live mode"
          />
          <label
            htmlFor="castrade-auto"
            className="hidden text-[9px] text-muted-foreground lg:inline"
          >
            Auto 60s
          </label>
        </div>

        {data && (
          <Badge
            variant={data.mode === 'live' ? 'default' : 'secondary'}
            className={cn('ml-0.5 h-4 px-1 text-[8px]', data.mode === 'live' && 'bg-emerald-600')}
          >
            {data.live ? 'LIVE TICKS' : data.mode === 'live' ? 'LIVE' : 'REPLAY'}
          </Badge>
        )}

        {data?.live && data.feed && (
          <Badge
            variant={data.feed.connected ? 'default' : 'destructive'}
            className={cn(
              'h-4 px-1 font-mono text-[8px]',
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
          <div className="mr-1 hidden items-center gap-2 font-mono text-[9px] text-muted-foreground xl:flex">
            <span>
              Spot {fmtPrice(data.spot.at_window_start)} → {fmtPrice(data.spot.at_decision)}
              {data.spot.projected_exit ? ` → ${fmtPrice(data.spot.projected_exit)}*` : ''}
            </span>
            <span>
              ATM CE {fmtStrike(data.ce_atm ?? data.atm)} · PE {fmtStrike(data.pe_atm ?? data.atm)}
            </span>
            <span>Step {data.strike_step}</span>
            <span>Lot {data.lot_size}</span>
            {!data.is_expiry_day && (
              <Badge variant="outline" className="h-3.5 px-1 text-[8px] text-amber-600">
                NOT EXPIRY DAY
              </Badge>
            )}
          </div>
        )}
        <AccountControls variant="toolbar" />
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT - two side canvases */}
        <main className="min-w-0 flex-1 overflow-y-auto p-1.5">
          {error && (
            <div
              role="alert"
              className="mb-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}

          {!data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <Crosshair className="h-7 w-7 opacity-40" />
              <p>
                Pick an underlying, an expiry and a trade date, then press{' '}
                <span className="font-semibold text-foreground">Analyze</span> (replay) or{' '}
                <span className="font-semibold text-foreground">Go Live</span> (tick-by-tick).
              </p>
              <p className="max-w-md text-xs">
                SEVEN strikes on one ladder around the 15:15 baseline spot (3 below + ATM + 3
                above), each with a CE and a PE leg — 14 total. Two real-time canvases (CE left
                chart, PE chart below) draw the candles tick by tick and show the predicted
                positive-return strike per side. The engine locks ONE strike at {config.entryTime},
                exit {config.exitTime}.
              </p>
            </div>
          ) : (
            <>
              {/* Spot strip (compact) */}
              <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border bg-card px-2.5 py-1 font-mono text-[9px] text-muted-foreground">
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
                      data.votes.winning === 'CE'
                        ? 'font-bold text-emerald-600 dark:text-emerald-400'
                        : ''
                    }
                  >
                    CE {data.votes.ce > 0 ? '+' : ''}
                    {data.votes.ce.toFixed(2)}
                  </span>{' '}
                  /{' '}
                  <span className={data.votes.winning === 'PE' ? 'font-bold text-amber-600' : ''}>
                    PE {data.votes.pe > 0 ? '+' : ''}
                    {data.votes.pe.toFixed(2)}
                  </span>
                  {typeof data.votes.margin === 'number' && (
                    <span className="text-muted-foreground/70">
                      {' '}
                      (m {data.votes.margin >= 0 ? '+' : ''}
                      {data.votes.margin.toFixed(2)})
                    </span>
                  )}
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
                    phase <span className="text-foreground/70">{data.phase ?? 'live'}</span>
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
                  <TrendingUp className="mr-0.5 inline h-2.5 w-2.5 text-emerald-500" />
                  CE basket {data.cond_a.CE.banned ? 'BANNED' : 'ok'}
                  {' · '}
                  <TrendingDown className="mr-0.5 inline h-2.5 w-2.5 text-red-500" />
                  PE basket {data.cond_a.PE.banned ? 'BANNED' : 'ok'}
                </span>
              </div>

              {/* The two side canvases */}
              <div className="flex flex-col gap-1.5">
                <SideChartCard
                  side="CE"
                  data={data}
                  repLeg={ceRep}
                  predicted={ceRep}
                  isDark={isDark}
                />
                <SideChartCard
                  side="PE"
                  data={data}
                  repLeg={peRep}
                  predicted={peRep}
                  isDark={isDark}
                />
              </div>
            </>
          )}
        </main>

        {/* Drag handle + RIGHT resizable panel */}
        <div
          role="slider"
          aria-orientation="vertical"
          aria-label="Resize panel (drag or use arrow keys)"
          aria-valuenow={panelW}
          aria-valuemin={280}
          aria-valuemax={720}
          tabIndex={0}
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-amber-500/50 focus-visible:bg-amber-500/70 focus-visible:outline-none"
          onMouseDown={(e) => {
            e.preventDefault()
            draggingRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setPanelW((w) => Math.min(720, w + 24))
            if (e.key === 'ArrowRight') setPanelW((w) => Math.max(280, w - 24))
          }}
          data-testid="castrade-panel-resizer"
        />
        <aside
          className="flex shrink-0 flex-col gap-1.5 overflow-y-auto border-l p-1.5"
          style={{ width: panelW }}
          data-testid="castrade-side-panel"
        >
          {data ? (
            <>
              <StrikesPanel
                data={data}
                ceLegs={ceLegs}
                peLegs={peLegs}
                predictedKeys={predictedKeys}
                onQuickOrder={quickOrder}
              />
              <FinalTradePanel
                data={data}
                lots={config.lots}
                onLotsChange={(n) => setConfig((c) => ({ ...c, lots: n }))}
                onOrder={placeOrder}
                orderBusy={orderBusy}
              />
              <FundsSlider
                data={data}
                lots={config.lots}
                onApplyLots={(n) => setConfig((c) => ({ ...c, lots: n }))}
              />
              <EventsList events={data.events} />
            </>
          ) : (
            <div className="rounded-lg border bg-card px-2.5 py-5 text-center text-[11px] text-muted-foreground">
              Run an analysis to see the strikes board and the final trade.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
