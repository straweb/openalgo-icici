/**
 * The deploy panel: a trading surface built the hedging terminal's way, and
 * the quick actions that fire it in one tap.
 *
 * The underlying is picked in the title band — a broker-wide autocomplete
 * (index, F&O underlying or plain equity) that charts the pick, so the
 * panel and the chart always agree on what is being traded. An underlying
 * with options gets the two-pane strike ladder — CALLS | PUTS, resizable
 * between — and an underlying without options gets a stock list with plain
 * buy/sell rows.
 *
 * Nothing waits for the chain snapshot: the ATM and the offset picks come
 * from the underlying's live quote on the underlying's default strike grid
 * (the chain's own spacing overrides it the moment it lands). A missed
 * snapshot is a poll away — the panel never banners it. Strikes added
 * before the snapshot arrives carry the OpenAlgo symbol convention
 * (`NIFTY09NOV2617350CE`) and the reconcile pass swaps each for the chain's
 * exact listed symbol when the snapshot comes in.
 *
 * The panel binds to the workspace, not to the focused chart: multi-layout
 * grids can move the trader's focus pane without moving what this panel
 * trades. Only the title combobox (or the FNO/Equity switch beside it)
 * changes the binding, and the binding survives a reload.
 *
 * Sizing is capital-weighted the hedging engine's way: every side — CALLS,
 * PUTS and the stock list — divides the funds across its enabled rows, and
 * the shares always sum to 100 percent; a row shows the lots (or shares)
 * its percent buys at the live price. The action bar sits static at the
 * bottom: deploy / close per side, the two swaps (leave one side, enter the
 * other), exit all, Schedule and Deploy by level.
 */

import {
  CalendarClock,
  CirclePlus,
  Layers,
  Loader2,
  RefreshCw,
  Rocket,
  SearchIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { optionChainApi } from '@/api/option-chain'
import { scalpingApi } from '@/api/scalping'
import { tradingApi } from '@/api/trading'
import { IndexDeployDialog, type IndexDeploySubmit } from '@/components/hedging/IndexDeployDialog'
import { strikeAccent } from '@/components/hedging/InstrumentPanel'
import { SchedulerDialog, type SchedulerSubmit } from '@/components/hedging/SchedulerDialog'
import { DeployRowItem } from '@/components/trading/DeployRowItem'
import { SymbolCombobox, searchInstruments } from '@/components/trading/SymbolCombobox'
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { newScheduleId, scheduleActionLabel } from '@/lib/hedging/scheduler'
import { strikesForPick } from '@/lib/hedging/indexLevels'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import type { ChartContext } from '@/lib/trading/chartContract'
import {
  bookKey,
  chainLtp,
  constructedRows,
  defaultLotSize,
  defaultStrikeStep,
  equalSplitSide,
  ensureSideWeights,
  firingRows,
  normalizeSideWeights,
  readDeployState,
  reconcileConstructed,
  rowsFromStrikes,
  rowQty,
  slideSideWeight,
  stockRowFromSearch,
  type DeployBook,
  type DeployRow,
  type RowSide,
  type Sizing,
  writeDeployState,
} from '@/lib/trading/deployPlan'
import {
  armCloseRows,
  buildDeployPlan,
  levelEntryMet,
  placeLevelOrders,
  resolveLevelPick,
} from '@/lib/trading/levelDeploy'
import { armLadderBatch, armPastMiss } from '@/lib/trading/scheduleArm'
import { planCrosses, swapFireOrders } from '@/lib/trading/tradingFire'
import type { SearchRow } from '@/lib/trading/terminal'
import { fnoExchangeFor, type ScheduledOrder } from '@/types/hedging'
import type { OptionChainResponse } from '@/types/option-chain'
import type { Position } from '@/types/trading'
import { cn } from '@/lib/utils'
import { PANEL_HEADER, PanelShell } from './panelShell'
import { showToast } from '@/utils/toast'

/** The hedging panel's one-tap ladder, shortened to fit a side panel. */
const OFFSET_BUTTONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const CHAIN_POLL_MS = 5000
const QUOTE_POLL_MS = 4000
const FUNDS_POLL_MS = 15000
const BOOK_POLL_MS = 6000

interface Props {
  apiKey: string
  /**
   * The focused pane's instrument, read fresh like the Backtest panel reads
   * its own — used ONLY to seed the workspace binding at mount and to light
   * the row that is on the chart. The binding itself never follows it.
   */
  getChartContext(): ChartContext | null
  chartRevision: number
  /** Charts an instrument in the focused pane (row chart buttons, picks). */
  onPick(row: SearchRow): void
}

type BusyKey =
  | 'deployCE'
  | 'deployPE'
  | 'closeCE'
  | 'closePE'
  | 'swapCE'
  | 'swapPE'
  | 'exitAll'
  | 'buyAll'
  | 'sellAll'

const NO_BUSY: Record<BusyKey, boolean> = {
  deployCE: false,
  deployPE: false,
  closeCE: false,
  closePE: false,
  swapCE: false,
  swapPE: false,
  exitAll: false,
  buyAll: false,
  sellAll: false,
}

export function DeployPanel({ apiKey, getChartContext, chartRevision, onPick }: Props) {
  const [state, setState] = useState<DeployBook>(() => ensureSideWeights(readDeployState()))
  /**
   * The workspace binding — the panel's own instrument. Seeded from the
   * persisted state (or the charted one at mount), then moved only by the
   * title combobox; focusing another pane never moves it.
   */
  const [workspace, setWorkspace] = useState<{ symbol: string; exchange: string } | null>(
    () => state.workspace ?? getChartContext()
  )
  /** FNO / Equity switch: auto until the trader flips it for this underlying. */
  const [modeOverride, setModeOverride] = useState<'auto' | 'fno' | 'equity'>('auto')
  const [side, setSide] = useState<'CE' | 'PE'>('CE')
  const [dir, setDir] = useState<1 | -1>(1)
  const [chain, setChain] = useState<OptionChainResponse | null>(null)
  const [expiry, setExpiry] = useState('')
  const [expiries, setExpiries] = useState<string[]>([])
  const [nOpen, setNOpen] = useState(false)
  const [nCount, setNCount] = useState(5)
  const [custom, setCustom] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [busy, setBusy] = useState<Record<BusyKey, boolean>>(NO_BUSY)
  const [expiryNotice, setExpiryNotice] = useState<string | null>(null)
  const [expiryFailed, setExpiryFailed] = useState(false)
  const [underlyingLtp, setUnderlyingLtp] = useState<number | undefined>(undefined)
  const [quotes, setQuotes] = useState<Record<string, number>>({})
  const [funds, setFunds] = useState(0)
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const [orderKeys, setOrderKeys] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [levelOpen, setLevelOpen] = useState(false)
  const [stockAddOpen, setStockAddOpen] = useState(false)
  const [stockQuery, setStockQuery] = useState('')
  const [stockHits, setStockHits] = useState<Array<{ symbol: string; exchange: string; name?: string; lotsize?: number }>>([])
  const [stockSearching, setStockSearching] = useState(false)
  const stockRequestId = useRef(0)

  /** The panel is a trading surface: what the trader built survives a reload. */
  const save = useCallback((next: DeployBook) => {
    setState(next)
    writeDeployState(next)
  }, [])

  /** The charted instrument — row highlighting only; the binding never follows it. */
  const charted = useMemo(
    () => getChartContext(),
    // Deliberate re-read trigger, the Backtest panel's chartRevision contract:
    // the chart is not a React value, the counter says when to ask again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the re-read trigger
    [getChartContext, chartRevision]
  )
  const underlying = workspace?.symbol ?? ''
  const optionsExchange = useMemo(
    () => fnoExchangeFor(workspace?.exchange ?? 'NSE'),
    [workspace?.exchange]
  )
  const key = bookKey(optionsExchange, underlying)
  const ladder = state.books[key] ?? { ce: [], pe: [] }
  /** Options when the underlying lists them — or when the trader flips to FNO. */
  const optionsMode =
    modeOverride === 'fno' ? true : modeOverride === 'equity' ? false : expiries.length > 0

  /** The title combobox is the only thing that moves the binding. */
  const bindWorkspace = useCallback((pick: { symbol: string; exchange: string }) => {
    setWorkspace(pick)
    setState((previous) => {
      const next: DeployBook = { ...previous, workspace: pick }
      writeDeployState(next)
      return next
    })
  }, [])

  const patchRows = useCallback(
    (side: 'CE' | 'PE', rows: DeployRow[]) => {
      setState((previous) => {
        const keyStr = bookKey(optionsExchange, underlying)
        const book = previous.books[keyStr] ?? { ce: [], pe: [] }
        const next: DeployBook = {
          ...previous,
          books: {
            ...previous.books,
            [keyStr]: { ...book, [side === 'CE' ? 'ce' : 'pe']: rows },
          },
        }
        writeDeployState(next)
        return next
      })
    },
    [optionsExchange, underlying]
  )

  const patchStocks = useCallback((rows: DeployRow[]) => {
    setState((previous) => {
      const next: DeployBook = { ...previous, stocks: rows }
      writeDeployState(next)
      return next
    })
  }, [])

  /* ── expiries, then the chain ───────────────────────────────────── */
  const loadExpiries = useCallback(async () => {
    if (!underlying) return
    try {
      const res = await scalpingApi.getExpiry(underlying, optionsExchange, 'options')
      const list = res.data ?? []
      setExpiries(list)
      setExpiry((current) => (current && list.includes(current) ? current : (list[0] ?? '')))
      setExpiryFailed(false)
      setExpiryNotice(list.length === 0 ? `${underlying} has no option chain listed` : null)
    } catch {
      setExpiries([])
      setExpiryFailed(true)
      setExpiryNotice(`Could not load expiries for ${underlying}`)
    }
  }, [underlying, optionsExchange])

  useEffect(() => {
    setChain(null)
    setExpiries([])
    setExpiry('')
    setExpiryNotice(null)
    setExpiryFailed(false)
    setUnderlyingLtp(undefined)
    setModeOverride('auto')
    void loadExpiries()
  }, [loadExpiries])

  // A transient expiry miss retries quietly — the mode detection and the
  // expiry select both hang off this one list, so it must land.
  useEffect(() => {
    if (!underlying || !expiryFailed) return
    const timer = window.setInterval(() => void loadExpiries(), 15000)
    return () => window.clearInterval(timer)
  }, [underlying, expiryFailed, loadExpiries])

  /**
   * The chain snapshot, polled. A missed or failed poll keeps the last good
   * chain and stays silent: the ATM and the picks work off the live quote,
   * so an intermittent broker hiccup never becomes a red banner.
   */
  const loadChain = useCallback(async () => {
    if (!underlying || !expiry) return
    try {
      const res = await optionChainApi.getOptionChain(apiKey, underlying, optionsExchange, expiry, 50)
      if (res.status === 'success') setChain(res)
    } catch {
      // the next poll retries; the quote-driven picks keep working meanwhile
    }
  }, [apiKey, underlying, optionsExchange, expiry])

  useEffect(() => {
    void loadChain()
    const timer = window.setInterval(() => void loadChain(), CHAIN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadChain])

  /* ── constructed rows promote to the chain's exact symbols ───────────── */
  const promotedRef = useRef(false)
  useEffect(() => {
    if (!chain || chain.chain.length === 0) return
    promotedRef.current = false
    setState((previous) => {
      const keyStr = bookKey(optionsExchange, underlying)
      const book = previous.books[keyStr]
      if (!book) return previous
      const ce = reconcileConstructed(chain, book.ce, optionsExchange)
      const pe = reconcileConstructed(chain, book.pe, optionsExchange)
      if (ce.promoted === 0 && pe.promoted === 0) return previous
      promotedRef.current = true
      const next: DeployBook = {
        ...previous,
        books: { ...previous.books, [keyStr]: { ce: ce.rows, pe: pe.rows } },
      }
      writeDeployState(next)
      return next
    })
  }, [chain, optionsExchange, underlying])

  /* ── the underlying's own quote: the ATM without the chain ───────────── */
  const quoteExchangeRef = useRef<string | null>(null)
  useEffect(() => {
    quoteExchangeRef.current = null
  }, [underlying])

  useEffect(() => {
    if (!underlying) return
    let alive = true
    const poll = async () => {
      const candidates: string[] = []
      if (workspace?.exchange) candidates.push(workspace.exchange)
      for (const fallback of ['NSE_INDEX', 'NSE']) {
        if (!candidates.includes(fallback)) candidates.push(fallback)
      }
      for (const exchange of candidates) {
        try {
          const res = await tradingApi.getQuotes(apiKey, underlying, exchange)
          if (res.status === 'success' && Number.isFinite(res.data?.ltp)) {
            quoteExchangeRef.current = exchange
            if (alive) setUnderlyingLtp(res.data!.ltp)
            return
          }
        } catch {
          // the next candidate exchange tries on
        }
        if (!alive) return
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), QUOTE_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [apiKey, underlying, workspace?.exchange])

  /* ── row quotes: the ladder's prices off the chain AND the quotes feed ── */
  const rowSymbols = useMemo(() => {
    const list: Array<{ symbol: string; exchange: string }> = []
    for (const row of [...ladder.ce, ...ladder.pe, ...(optionsMode ? [] : state.stocks)]) {
      list.push({ symbol: row.symbol, exchange: row.exchange })
    }
    return list.slice(0, 40)
  }, [ladder.ce, ladder.pe, state.stocks, optionsMode])

  useEffect(() => {
    if (rowSymbols.length === 0) return
    let alive = true
    const poll = async () => {
      try {
        const res = await tradingApi.getMultiQuotes(apiKey, rowSymbols)
        if (!alive) return
        const next: Record<string, number> = {}
        for (const item of res.results ?? []) {
          if (item.data && Number.isFinite(item.data.ltp)) next[item.symbol] = item.data.ltp
        }
        setQuotes(next)
      } catch {
        // the chain poll and the next pass keep the feed alive
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), QUOTE_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [apiKey, rowSymbols])

  /* ── funds: the pool the weight shares divide ─────────────────────────── */
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await tradingApi.getFunds(apiKey)
        if (alive && res.status === 'success' && res.data) {
          setFunds(Number(res.data.availablecash) || 0)
        }
      } catch {
        // manual lots keep working without a funds snapshot
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), FUNDS_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [apiKey])

  /* ── positions + live orders: P&L, Close, and the row highlights ──────── */
  useEffect(() => {
    let alive = true
    const poll = async () => {
      const [posRes, ordRes] = await Promise.allSettled([
        tradingApi.getPositions(apiKey),
        tradingApi.getOrders(apiKey),
      ])
      if (!alive) return
      if (posRes.status === 'fulfilled' && posRes.value.status === 'success') {
        const map = new Map<string, Position>()
        for (const position of posRes.value.data ?? []) {
          if (position.quantity !== 0) map.set(`${position.exchange}:${position.symbol}`, position)
        }
        setPositions(map)
      }
      if (ordRes.status === 'fulfilled' && ordRes.value.status === 'success') {
        const live = new Set<string>()
        for (const order of ordRes.value.data?.orders ?? []) {
          if (['open', 'pending', 'trigger pending'].includes(order.order_status)) {
            live.add(`${order.exchange}:${order.symbol}`)
          }
        }
        setOrderKeys(live)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), BOOK_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [apiKey])

  /* ── derived: grid, ATM, sizing ───────────────────────────────────────── */
  const interval = useMemo(() => {
    const strikes = chain?.chain.map((row) => row.strike) ?? []
    if (strikes.length >= 2) {
      const sorted = [...new Set(strikes)].sort((a, b) => a - b)
      const gaps = sorted.slice(1).map((s, i) => s - sorted[i])
      const chainInterval = Math.min(...gaps.filter((g) => g > 0))
      if (chainInterval > 0) return chainInterval
    }
    return defaultStrikeStep(underlying)
  }, [chain, underlying])

  // The ATM lands from the chain when it can and from the live quote when it
  // cannot — the picks work either way, the hedging terminal's way.
  const atm = chain?.atm_strike || (underlyingLtp && interval ? Math.round(underlyingLtp / interval) * interval : null)

  const ltpOf = useCallback(
    (row: DeployRow) => quotes[row.symbol] ?? chainLtp(chain, row.symbol),
    [quotes, chain]
  )
  const sizing = useMemo(() => ({ capital: funds, ltpOf }), [funds, ltpOf])
  /** One lot (or one share) of the bound underlying, in rupees, for the title. */
  const titleLotSize = optionsMode
    ? chain?.chain[0]?.ce?.lotsize ||
      chain?.chain[0]?.pe?.lotsize ||
      defaultLotSize(underlying)
    : 1

  /* ── add strips ───────────────────────────────────────────────────────── */
  const addStrikes = useCallback(
    (strikes: number[]) => {
      const existing = ladder[side === 'CE' ? 'ce' : 'pe']
      let next: DeployRow[]
      let skipped: number[] = []
      if (chain && chain.chain.length > 0) {
        const resolved = rowsFromStrikes(chain, side, strikes, existing, optionsExchange)
        next = resolved.rows
        skipped = resolved.skipped
      } else {
        next = constructedRows(
          side,
          strikes,
          { base: underlying, expiry, exchange: optionsExchange },
          existing
        )
      }
      // The side re-divides the funds across its rows, back to 100.
      next = equalSplitSide(normalizeSideWeights(next), side)
      patchRows(side, next)
      if (skipped.length > 0) {
        showToast.warning(
          `${side}: ${skipped.length} strike${skipped.length === 1 ? '' : 's'} not on the chain snapshot (not listed) — the rest added.`
        )
      }
    },
    [chain, side, ladder, underlying, expiry, optionsExchange, patchRows]
  )

  // The ± button inverts what "1..10" and the N picker mean: offsets above or
  // below ATM, exactly the hedging add-strip's behaviour — named in the
  // option's own terms, a call goes OTM above the spot, a put goes ITM.
  const dirLabel = side === 'CE' ? (dir === 1 ? 'OTM' : 'ITM') : dir === 1 ? 'ITM' : 'OTM'

  const offsetStrikes = (offsets: number[]) => {
    if (!atm || !interval) return []
    return offsets.map((offset) => atm + offset * interval * dir)
  }

  const addN = () => {
    const wanted = strikesForPick({ mode: dir === 1 ? 'above' : 'below', count: nCount }, atm, interval)
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

  const addStock = (hit: { symbol: string; exchange: string; name?: string; lotsize?: number }) => {
    if (state.stocks.some((row) => row.symbol === hit.symbol && row.exchange === hit.exchange)) {
      showToast.info(`${hit.symbol} is already on the list.`)
      setStockAddOpen(false)
      return
    }
    const next = equalSplitSide(
      normalizeSideWeights([...state.stocks, stockRowFromSearch(hit)]),
      'EQ'
    )
    patchStocks(next)
    setStockAddOpen(false)
    setStockQuery('')
    setStockHits([])
  }

  // The stock strip searches while it is open — the same broker-wide search
  // the title combobox runs.
  useEffect(() => {
    if (!stockAddOpen) return
    const trimmed = stockQuery.trim()
    if (trimmed.length < 2) {
      setStockHits([])
      setStockSearching(false)
      return
    }
    const id = ++stockRequestId.current
    setStockSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const list = await searchInstruments(apiKey, trimmed)
        if (id !== stockRequestId.current) return
        setStockHits(list)
      } catch {
        if (id !== stockRequestId.current) return
        setStockHits([])
      } finally {
        if (id === stockRequestId.current) setStockSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [apiKey, stockAddOpen, stockQuery])

  /* ── firing ───────────────────────────────────────────────────────────── */
  const placeOrders = useCallback(
    async (orders: Array<{ symbol: string; exchange: string; action: 'BUY' | 'SELL'; quantity: number }>) => {
      let placed = 0
      let failed = 0
      for (const order of orders) {
        try {
          const res = await tradingApi.placeOrder({
            apikey: apiKey,
            strategy: 'DEPLOY',
            exchange: order.exchange,
            symbol: order.symbol,
            action: order.action,
            quantity: order.quantity,
            pricetype: state.pricetype,
            product: state.product,
          })
          if (res.status === 'success') placed += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      return { placed, failed }
    },
    [apiKey, state.pricetype, state.product]
  )

  const report = (label: string, placed: number, failed: number) => {
    if (failed === 0) showToast.success(`${label}: ${placed} order${placed === 1 ? '' : 's'} placed`)
    else if (placed === 0) showToast.error(`${label}: every order failed`)
    else showToast.warning(`${label}: ${placed} placed, ${failed} failed`)
  }

  const fire = useCallback(
    async (action: 'BUY' | 'SELL', target: 'CE' | 'PE', busyKey: BusyKey, label: string) => {
      const rows = ladder[target === 'CE' ? 'ce' : 'pe']
      const plan = firingRows(rows, sizing)
      if (plan.length === 0) {
        showToast.warning(`${label}: no ${target} rows the funds can size right now`)
        return
      }
      setBusy((previous) => ({ ...previous, [busyKey]: true }))
      const { placed, failed } = await placeOrders(
        plan.map(({ row, qty }) => ({
          symbol: row.symbol,
          exchange: row.exchange,
          action,
          quantity: qty,
        }))
      )
      setBusy((previous) => ({ ...previous, [busyKey]: false }))
      report(label, placed, failed)
    },
    [ladder, state.lots, sizing, placeOrders]
  )

  const fireStocks = useCallback(
    async (action: 'BUY' | 'SELL', busyKey: BusyKey, label: string) => {
      const plan = firingRows(state.stocks, sizing)
      if (plan.length === 0) {
        showToast.warning(`${label}: no stock rows the funds can size right now`)
        return
      }
      setBusy((previous) => ({ ...previous, [busyKey]: true }))
      const { placed, failed } = await placeOrders(
        plan.map(({ row, qty }) => ({
          symbol: row.symbol,
          exchange: row.exchange,
          action,
          quantity: qty,
        }))
      )
      setBusy((previous) => ({ ...previous, [busyKey]: false }))
      report(label, placed, failed)
    },
    [state.stocks, sizing, placeOrders]
  )

  const runSwap = useCallback(
    async (from: 'CE' | 'PE') => {
      const orders = swapFireOrders(ladder, from, sizing)
      if (orders.length === 0) {
        showToast.warning(`Swap ${from}→${from === 'CE' ? 'PE' : 'CE'}: no enabled rows on either side`)
        return
      }
      const busyKey: BusyKey = from === 'CE' ? 'swapCE' : 'swapPE'
      setBusy((previous) => ({ ...previous, [busyKey]: true }))
      const { placed, failed } = await placeOrders(orders)
      setBusy((previous) => ({ ...previous, [busyKey]: false }))
      report(`Swap ${from}→${from === 'CE' ? 'PE' : 'CE'}`, placed, failed)
    },
    [ladder, state.lots, sizing, placeOrders]
  )

  const exitAll = useCallback(async () => {
    if (optionsMode) {
      const plan = firingRows([...ladder.ce, ...ladder.pe], sizing)
      if (plan.length === 0) {
        showToast.warning('Exit All: no enabled rows')
        return
      }
      setBusy((previous) => ({ ...previous, exitAll: true }))
      const { placed, failed } = await placeOrders(
        plan.map(({ row, qty }) => ({
          symbol: row.symbol,
          exchange: row.exchange,
          action: 'SELL' as const,
          quantity: qty,
        }))
      )
      setBusy((previous) => ({ ...previous, exitAll: false }))
      report('Exit All', placed, failed)
    } else {
      await fireStocks('SELL', 'exitAll', 'Exit All')
    }
  }, [optionsMode, ladder, state.lots, sizing, placeOrders, fireStocks])

  /* ── Schedule: the dock's dialog, pointed at this panel's ladder ──────── */
  const spot = useMemo(() => {
    if (chain?.underlying_symbol) {
      return {
        symbol: chain.underlying_symbol,
        exchange: chain.underlying_exchange ?? optionsExchange,
      }
    }
    if (!underlying) return null
    return { symbol: underlying, exchange: workspace?.exchange === 'NSE' ? 'NSE' : 'NSE_INDEX' }
  }, [chain, underlying, optionsExchange, workspace?.exchange])

  const submitSchedule = useCallback(
    (submission: SchedulerSubmit) => {
      if (!underlying) return
      const row = armLadderBatch(submission, { underlying, spot, ladder })
      const miss = armPastMiss(row)
      const hedging = loadHedgingState()
      saveHedgingState({ ...hedging, scheduled: [...hedging.scheduled, row] })
      if (miss === 'missed') {
        showToast.warning(`${row.trigger.kind === 'time' ? row.trigger.at : 'That level'} has already passed — nothing scheduled.`)
      } else if (miss === 'daily') {
        showToast.info(`${row.trigger.kind === 'time' ? row.trigger.at : 'The level'} runs at the next trading day's pass.`)
      } else {
        showToast.success(
          `${scheduleActionLabel(row.action, row.modeAtCreation, row.target)} scheduled — it fires this panel's ladder for ${underlying}.`
        )
      }
    },
    [underlying, spot, ladder]
  )

  /* ── Deploy by level: the dock's dialog, writing this panel's ladder ──── */
  const submitLevel = useCallback(
    async (plan: IndexDeploySubmit) => {
      if (!chain || !underlying) {
        showToast.warning('Deploy by level needs the chain snapshot — it has not landed yet.')
        return
      }
      const existing = ladder[plan.side === 'CE' ? 'ce' : 'pe']
      const resolved = resolveLevelPick({ chain, interval, plan, existing, optionsExchange })
      if (!resolved || resolved.picked.length === 0) {
        showToast.warning('No strikes resolved for that pick.')
        return
      }
      // Into the ladder first: the trader sees exactly what is set.
      patchRows(plan.side, resolved.rows)
      if (resolved.skipped.length > 0) {
        showToast.warning(
          `${plan.side}: ${resolved.skipped.length} of ${resolved.planned.length} strikes are not on the chain — the rest set.`
        )
      }
      const deploy = buildDeployPlan({ plan, picked: resolved.picked, spot, optionsExchange })
      if (levelEntryMet(plan, chain.underlying_ltp)) {
        setBusy((previous) => ({ ...previous, deployCE: plan.side === 'CE', deployPE: plan.side === 'PE' }))
        const { placed, failed } = await placeLevelOrders({
          apiKey,
          picked: resolved.picked,
          batchLots: state.lots,
          optionAction: plan.optionAction,
          product: state.product,
          pricetype: state.pricetype,
        })
        setBusy((previous) => ({ ...previous, deployCE: false, deployPE: false }))
        if (placed === 0) {
          showToast.error('Index deploy: every order failed')
          return
        }
        showToast.success(
          `Index deploy: ${placed} order${placed === 1 ? '' : 's'} placed${failed > 0 ? `, ${failed} failed` : ''}`
        )
        armCloseRows(deploy, spot)
        return
      }
      if (!spot) {
        showToast.error('The spot symbol is not known yet — cannot set an index trigger.')
        return
      }
      const crosses = planCrosses({ side: plan.side, optionAction: plan.optionAction })
      const row: ScheduledOrder = {
        id: newScheduleId(),
        action: plan.side === 'CE' ? 'deployA' : 'deployB',
        trigger: {
          kind: 'price',
          symbol: spot.symbol,
          exchange: spot.exchange,
          condition: crosses.target,
          price: plan.entry as number,
        },
        status: 'pending',
        createdAt: Date.now(),
        modeAtCreation: 'fno',
        target: 'options',
        origin: 'trading',
        deploy,
      }
      const hedging = loadHedgingState()
      saveHedgingState({ ...hedging, scheduled: [...hedging.scheduled, row] })
      showToast.info(
        `Set: ${plan.optionAction} ${plan.side} ×${deploy.strikes.length} when ${spot.symbol} ${crosses.target === 'above' ? '≥' : '≤'} ${(plan.entry as number).toLocaleString('en-IN')}. It fires this panel's ladder.`
      )
    },
    [chain, underlying, ladder, interval, optionsExchange, patchRows, spot, apiKey, state.lots, state.product, state.pricetype]
  )

  /* ── row editing ─────────────────────────────────────────────────────── */
  const updateRow = useCallback(
    (where: RowSide, symbol: string, patch: (row: DeployRow) => DeployRow) => {
      if (where === 'EQ') {
        patchStocks(state.stocks.map((row) => (row.symbol === symbol ? patch(row) : row)))
        return
      }
      const rows = ladder[where === 'CE' ? 'ce' : 'pe']
      patchRows(where, rows.map((row) => (row.symbol === symbol ? patch(row) : row)))
    },
    [state.stocks, ladder, patchRows, patchStocks]
  )

  const removeRow = useCallback(
    (where: RowSide, symbol: string) => {
      if (where === 'EQ') {
        patchStocks(state.stocks.filter((row) => row.symbol !== symbol))
        return
      }
      patchRows(where, ladder[where === 'CE' ? 'ce' : 'pe'].filter((row) => row.symbol !== symbol))
    },
    [state.stocks, ladder, patchRows, patchStocks]
  )

  const btn = (busyKey: BusyKey, label: string, tone: 'green' | 'red' | 'amber' | 'sky', onClick: () => void, title?: string, disabled?: boolean) => (
    <Button
      size="sm"
      disabled={busy[busyKey] || disabled}
      onClick={onClick}
      title={title ?? label}
      className={cn(
        'h-6 flex-1 px-1 text-[10px] font-medium',
        tone === 'green' && 'bg-emerald-600 text-white hover:bg-emerald-700',
        tone === 'red' && 'bg-red-600 text-white hover:bg-red-700',
        tone === 'amber' && 'bg-amber-500 text-white hover:bg-amber-600',
        tone === 'sky' && 'bg-sky-700 text-white hover:bg-sky-800'
      )}
    >
      {busy[busyKey] && <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />}
      {label}
    </Button>
  )

  /* ── render ─────────────────────────────────────────────────────────── */
  return (
    <PanelShell
      id="oa-panel-deploy"
      label="Deploy"
      storageKey="oa-trading-deploy-width"
      defaultWidth={440}
      maxWidth={560}
    >
      {/* ── Header: identity + underlying autocomplete + expiry ─────────── */}
      <div className={PANEL_HEADER}>
        <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold">Deploy</span>
        <SymbolCombobox
          apiKey={apiKey}
          current={workspace}
          onPick={(hit) => {
            bindWorkspace({ symbol: hit.symbol, exchange: hit.exchange })
            onPick({ symbol: hit.symbol, exchange: hit.exchange, name: hit.name })
          }}
          placeholder="NIFTY, RELIANCE, TCS…"
        />
        {/* FNO / Equity: what this panel trades — the ladder or the stock list. */}
        <div
          className="flex shrink-0 overflow-hidden rounded border"
          title="FNO trades the option ladder; Equity trades the stock list"
        >
          {(['FNO', 'EQ'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setModeOverride(mode === 'FNO' ? 'fno' : 'equity')}
              className={cn(
                'px-1.5 py-0.5 text-[9px] font-semibold transition-colors',
                (mode === 'FNO') === optionsMode
                  ? 'bg-sky-700 text-white'
                  : 'bg-background text-muted-foreground hover:bg-accent'
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] tabular-nums"
          title={
            optionsMode
              ? 'The underlying LTP and the rupees one lot of it carries'
              : 'The LTP and the rupees one share carries'
          }
        >
          {underlyingLtp != null
            ? underlyingLtp.toLocaleString('en-IN', { maximumFractionDigits: 2 })
            : '—'}
          {underlyingLtp != null && (
            <span className="ml-1 text-muted-foreground">
              · {optionsMode ? '1 lot' : '1 sh'} ₹
              {(underlyingLtp * titleLotSize).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          )}
        </span>
        {optionsMode && (
          <Select value={expiry} onValueChange={setExpiry} disabled={expiries.length === 0}>
            <SelectTrigger className="h-6 w-[104px] shrink-0 px-1.5 text-[10px]">
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
        )}
        {optionsMode && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Refresh chain"
            onClick={() => void loadChain()}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
      </div>

      {expiryNotice && (
        <div className="border-b bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700">
          {expiryNotice}
        </div>
      )}
      {optionsMode && underlying && !atm && (
        <div className="border-b bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
          The ATM and offset picks land with {underlying}'s live quote — the custom-strike{' '}
          <CirclePlus className="inline h-2.5 w-2.5" /> button works meanwhile.
        </div>
      )}

      {/* ── Add strip: strikes for options, stock search otherwise ──────── */}
      {optionsMode ? (
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
            className="h-5 w-9 px-0 text-[10px] font-bold"
            onClick={() => setDir((value) => (value === 1 ? -1 : 1))}
            title={`Picks go ${dir === 1 ? 'above' : 'below'} ATM — ${dirLabel} for ${side}`}
          >
            {dirLabel}
          </Button>
          {OFFSET_BUTTONS.map((offset) => (
            <Button
              key={offset}
              size="sm"
              variant="outline"
              className="h-5 min-w-5 px-1 text-[10px]"
              disabled={!atm || !interval}
              onClick={() => addStrikes(offsetStrikes([offset]))}
              title={`Add ${dirLabel} ${offset} (${dir === 1 ? 'above' : 'below'} ATM)`}
            >
              {offset}
            </Button>
          ))}
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
              <Button size="sm" variant="outline" className="ml-auto h-5 px-1" title="Custom strike">
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
      ) : (
        <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-2 py-1">
          <span className="text-[10px] text-muted-foreground">
            {underlying ? `${underlying} has no options — stock list` : 'Stock list (buy/sell)'}
          </span>
          <Popover open={stockAddOpen} onOpenChange={setStockAddOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="ml-auto h-5 gap-1 px-1.5 text-[10px]">
                <SearchIcon className="h-2.5 w-2.5" />
                Add stock
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-2" align="end">
              <Input
                autoFocus
                value={stockQuery}
                onChange={(e) => setStockQuery(e.target.value)}
                placeholder="Search any stock…"
                className="h-7 text-xs"
              />
              <div className="mt-1 max-h-[200px] overflow-y-auto">
                {stockSearching && (
                  <p className="px-1 py-1 text-[10px] text-muted-foreground">Searching…</p>
                )}
                {!stockSearching && stockHits.length === 0 && stockQuery.trim().length >= 2 && (
                  <p className="px-1 py-1 text-[10px] text-muted-foreground">No stock found.</p>
                )}
                {stockHits.map((hit) => (
                  <button
                    key={`${hit.exchange}:${hit.symbol}`}
                    type="button"
                    onClick={() => addStock(hit)}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] hover:bg-accent"
                  >
                    <span className="font-mono font-semibold">{hit.symbol}</span>
                    <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                      {hit.exchange}
                    </span>
                    {hit.name && (
                      <span className="truncate text-[10px] text-muted-foreground">{hit.name}</span>
                    )}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {/* ── Panes: CALLS | PUTS resizable, or the stock list ────────────── */}
      <div className="min-h-0 flex-1">
        {optionsMode ? (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize={50} minSize={20}>
              <SidePane
                side="CE"
                rows={ladder.ce}
                atm={atm}
                interval={interval}
                capital={funds}
                quotes={quotes}
                chain={chain}
                underlying={underlying}
                positions={positions}
                orderKeys={orderKeys}
                collapsed={collapsed}
                chartSymbol={charted?.symbol ?? null}
                onToggleCollapse={(symbol) =>
                  setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (next.has(symbol)) next.delete(symbol)
                    else next.add(symbol)
                    return next
                  })
                }
                onToggle={(symbol) =>
                  updateRow('CE', symbol, (row) => {
                    const toggled = { ...row, enabled: !row.enabled }
                    return normalizeSideWeights(
                      ladder.ce.map((r) => (r.symbol === symbol ? toggled : r))
                    ).find((r) => r.symbol === symbol) ?? toggled
                  })
                }
                onWeight={(symbol, value) =>
                  patchRows('CE', slideSideWeight(ladder.ce, symbol, value))
                }
                onLevels={(symbol, levels) =>
                  updateRow('CE', symbol, (row) => ({ ...row, ...levels }))
                }
                onRemove={(symbol) => removeRow('CE', symbol)}
                onFire={(symbol, action) => {
                  const row = ladder.ce.find((r) => r.symbol === symbol)
                  if (!row) return
                  const qty = rowQtyOf(row, sizing)
                  if (qty <= 0) {
                    showToast.warning('Nothing to place at the current size — set the percent or manual lots first.')
                    return
                  }
                  void placeOrders([{ symbol: row.symbol, exchange: row.exchange, action, quantity: qty }])
                }}
                onExit={(symbol) => {
                  const row = ladder.ce.find((r) => r.symbol === symbol)
                  if (!row) return
                  const qty = rowQtyOf(row, sizing)
                  if (qty <= 0) {
                    showToast.warning('Exit: nothing to sell at the current size')
                    return
                  }
                  void placeOrders([{ symbol: row.symbol, exchange: row.exchange, action: 'SELL', quantity: qty }])
                }}
                onChart={(row) => onPick({ symbol: row.symbol, exchange: row.exchange, name: row.name })}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={20}>
              <SidePane
                side="PE"
                rows={ladder.pe}
                atm={atm}
                interval={interval}
                capital={funds}
                quotes={quotes}
                chain={chain}
                underlying={underlying}
                positions={positions}
                orderKeys={orderKeys}
                collapsed={collapsed}
                chartSymbol={charted?.symbol ?? null}
                onToggleCollapse={(symbol) =>
                  setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (next.has(symbol)) next.delete(symbol)
                    else next.add(symbol)
                    return next
                  })
                }
                onToggle={(symbol) =>
                  updateRow('PE', symbol, (row) => {
                    const toggled = { ...row, enabled: !row.enabled }
                    return normalizeSideWeights(
                      ladder.pe.map((r) => (r.symbol === symbol ? toggled : r))
                    ).find((r) => r.symbol === symbol) ?? toggled
                  })
                }
                onWeight={(symbol, value) =>
                  patchRows('PE', slideSideWeight(ladder.pe, symbol, value))
                }
                onLevels={(symbol, levels) =>
                  updateRow('PE', symbol, (row) => ({ ...row, ...levels }))
                }
                onRemove={(symbol) => removeRow('PE', symbol)}
                onFire={(symbol, action) => {
                  const row = ladder.pe.find((r) => r.symbol === symbol)
                  if (!row) return
                  const qty = rowQtyOf(row, sizing)
                  if (qty <= 0) {
                    showToast.warning('Nothing to place at the current size — set the percent or manual lots first.')
                    return
                  }
                  void placeOrders([{ symbol: row.symbol, exchange: row.exchange, action, quantity: qty }])
                }}
                onExit={(symbol) => {
                  const row = ladder.pe.find((r) => r.symbol === symbol)
                  if (!row) return
                  const qty = rowQtyOf(row, sizing)
                  if (qty <= 0) {
                    showToast.warning('Exit: nothing to sell at the current size')
                    return
                  }
                  void placeOrders([{ symbol: row.symbol, exchange: row.exchange, action: 'SELL', quantity: qty }])
                }}
                onChart={(row) => onPick({ symbol: row.symbol, exchange: row.exchange, name: row.name })}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="h-full overflow-y-auto">
            {state.stocks.length === 0 && (
              <p className="p-3 text-center text-[11px] text-muted-foreground">
                Add stocks with the search above — each row buys or sells in shares, sized by its
                percent of the funds.
              </p>
            )}
            {state.stocks.map((row) => (
              <DeployRowItem
                key={`${row.exchange}:${row.symbol}`}
                row={row}
                ltp={ltpOf(row)}
                accent={null}
                offsetLabel={null}
                capital={funds}
                pnl={rowPnl(row, positions, sizing)}
                inChart={charted?.symbol === row.symbol}
                hasPosition={positions.has(`${row.exchange}:${row.symbol}`)}
                hasOrder={orderKeys.has(`${row.exchange}:${row.symbol}`)}
                targetHit={row.target != null && ltpOf(row) != null && (ltpOf(row) as number) >= row.target}
                stopHit={row.stoploss != null && ltpOf(row) != null && (ltpOf(row) as number) <= row.stoploss}
                collapsed={collapsed.has(row.symbol)}
                onToggleCollapse={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous)
                    if (next.has(row.symbol)) next.delete(row.symbol)
                    else next.add(row.symbol)
                    return next
                  })
                }
                onToggle={() =>
                  patchStocks(
                    equalSplitSide(
                      normalizeSideWeights(
                        state.stocks.map((r) =>
                          r.symbol === row.symbol ? { ...r, enabled: !r.enabled } : r
                        )
                      ),
                      'EQ'
                    )
                  )
                }
                onWeight={(value) =>
                  patchStocks(slideSideWeight(state.stocks, row.symbol, value))
                }
                onLevels={(levels) => updateRow('EQ', row.symbol, (r) => ({ ...r, ...levels }))}
                onRemove={() => removeRow('EQ', row.symbol)}
                onFire={(action) => {
                  const qty = (row.lots > 0 ? row.lots : rowQtyOf(row, sizing)) * row.lotSize
                  if (qty <= 0) {
                    showToast.warning('Nothing to place at the current size')
                    return
                  }
                  void placeOrders([
                    { symbol: row.symbol, exchange: row.exchange, action, quantity: qty },
                  ])
                }}
                onExit={() => {
                  const qty = (row.lots > 0 ? row.lots : rowQtyOf(row, sizing)) * row.lotSize
                  if (qty <= 0) {
                    showToast.warning('Exit: nothing to sell at the current size')
                    return
                  }
                  void placeOrders([
                    { symbol: row.symbol, exchange: row.exchange, action: 'SELL', quantity: qty },
                  ])
                }}
                onChart={() => onPick({ symbol: row.symbol, exchange: row.exchange, name: row.name })}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Action bar: static at the bottom ────────────────────────────── */}
      <div className="shrink-0 border-t bg-muted/30 px-2 py-1.5">
        {optionsMode ? (
          <div className="flex items-center gap-1">
            {btn('deployCE', 'Deploy CE', 'green', () => void fire('BUY', 'CE', 'deployCE', 'Deploy CE'))}
            {btn('deployPE', 'Deploy PE', 'green', () => void fire('BUY', 'PE', 'deployPE', 'Deploy PE'))}
            {btn('closeCE', 'Close CE', 'red', () => void fire('SELL', 'CE', 'closeCE', 'Close CE'))}
            {btn('closePE', 'Close PE', 'red', () => void fire('SELL', 'PE', 'closePE', 'Close PE'))}
            {btn('swapCE', 'CE→PE', 'sky', () => void runSwap('CE'), 'Swap: close the CE rows, buy the PE rows')}
            {btn('swapPE', 'PE→CE', 'sky', () => void runSwap('PE'), 'Swap: close the PE rows, buy the CE rows')}
            {btn('exitAll', 'Exit All', 'amber', () => void exitAll())}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {btn('buyAll', 'Buy All', 'green', () => void fireStocks('BUY', 'buyAll', 'Buy All'))}
            {btn('sellAll', 'Sell All', 'red', () => void fireStocks('SELL', 'sellAll', 'Sell All'))}
            {btn('exitAll', 'Exit All', 'amber', () => void exitAll())}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1 text-[10px]">
          {optionsMode && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!underlying}
                title="Set a batch on this underlying's ladder"
                onClick={() => setScheduleOpen(true)}
              >
                <CalendarClock className="h-2.5 w-2.5" />
                Schedule
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={!chain}
                title="Deploy strikes by index level (entry, target, stop)"
                onClick={() => setLevelOpen(true)}
              >
                <Layers className="h-2.5 w-2.5" />
                Deploy by level
              </Button>
            </>
          )}
          <span
            className="ml-auto flex items-baseline gap-1 font-mono text-[10px] tabular-nums text-muted-foreground"
            title="Available capital the percent shares divide"
          >
            <span className="text-[9px] font-semibold uppercase">Avail</span>
            ₹{funds.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
          {optionsMode && (
            <span className="flex items-center gap-0.5" title="Lots per row when a row has no manual lots">
              <Input
                type="number"
                min={1}
                value={state.lots}
                onChange={(e) => {
                  const lots = Math.max(1, Math.floor(Number(e.target.value) || 1))
                  save({ ...state, lots })
                }}
                className="h-5 w-10 px-1 text-[10px]"
              />
              <span className="text-muted-foreground">lots</span>
            </span>
          )}
          <Select
            value={state.product}
            onValueChange={(product) => save({ ...state, product: product as DeployBook['product'] })}
          >
            <SelectTrigger className="h-5 w-[58px] px-1 text-[10px]">
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
            <SelectTrigger className="h-5 w-[66px] px-1 text-[10px]">
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

      {/* ── Dialogs: Schedule + Deploy by level ─────────────────────────── */}
      <SchedulerDialog
        open={scheduleOpen}
        mode="fno"
        initial={null}
        triggerSymbols={
          spot ? [spot, ...(underlying ? [{ symbol: underlying, exchange: 'NSE' }] : [])] : []
        }
        defaultSymbol={spot ?? undefined}
        spotSymbol={spot}
        actsOn={
          underlying
            ? { options: `${underlying} deploy ladder`, stock: underlying }
            : undefined
        }
        allowStockTarget={false}
        onOpenChange={setScheduleOpen}
        onSubmit={submitSchedule}
      />
      <IndexDeployDialog
        open={levelOpen}
        onOpenChange={setLevelOpen}
        spot={spot}
        spotLtp={chain?.underlying_ltp ?? underlyingLtp}
        atmStrike={atm ?? undefined}
        strikeInterval={interval || undefined}
        ceShare={loadHedgingState().ceShare}
        capitalNote="Quantity: each strike's weight share of the funds (or its manual lots). The picked strikes land in the ladder, where they stay adjustable. Triggers run while this page stays open."
        onSubmit={(plan) => void submitLevel(plan)}
      />
    </PanelShell>
  )
}

/* ── helpers shared by the panes and the stock list ──────────────────────── */

/** The quantity a row fires: manual lots, else its weight share of the funds. */
function rowQtyOf(row: DeployRow, sizing: Sizing): number {
  return rowQty(row, sizing.ltpOf?.(row), sizing.capital ?? 0)
}

/** P&L: the broker position's when one exists, else the entry level's mark. */
function rowPnl(
  row: DeployRow,
  positions: Map<string, Position>,
  sizing: Sizing
): number | undefined {
  const position = positions.get(`${row.exchange}:${row.symbol}`)
  if (position && position.quantity !== 0) return position.pnl
  const ltp = sizing.ltpOf?.(row)
  if (row.entry == null || ltp == null) return undefined
  const qty = rowQtyOf(row, sizing)
  if (qty <= 0) return undefined
  return (ltp - row.entry) * qty
}

/**
 * The moneyness badge, in the option's own terms: a CALL above the spot is
 * OTM (and the at-the-money strike itself reads ITM), a PUT above the spot
 * is ITM (and the at-the-money strike itself reads OTM). Steps carry their
 * distance — "OTM 3" is three strikes past the money on that side.
 */
function sideOffsetLabel(
  row: DeployRow,
  atm: number | null,
  interval: number
): string | null {
  if (row.kind !== 'option' || atm == null || !interval) return null
  const off = Math.round((row.strike - atm) / interval)
  if (row.optionType === 'CE') {
    if (off === 0) return 'ITM'
    return off > 0 ? `OTM ${off}` : `ITM ${Math.abs(off)}`
  }
  if (off === 0) return 'OTM'
  return off > 0 ? `ITM ${off}` : `OTM ${Math.abs(off)}`
}

/* ── one side's pane ─────────────────────────────────────────────────────── */

function SidePane(props: {
  side: 'CE' | 'PE'
  rows: DeployRow[]
  atm: number | null
  interval: number
  capital: number
  quotes: Record<string, number>
  chain: OptionChainResponse | null
  underlying: string
  positions: Map<string, Position>
  orderKeys: Set<string>
  collapsed: Set<string>
  chartSymbol: string | null
  onToggleCollapse(symbol: string): void
  onToggle(symbol: string): void
  onWeight(symbol: string, value: number): void
  onLevels(
    symbol: string,
    levels: { entry: number | null; target: number | null; stoploss: number | null }
  ): void
  onRemove(symbol: string): void
  onFire(symbol: string, action: 'BUY' | 'SELL'): void
  onExit(symbol: string): void
  onChart(row: DeployRow): void
}) {
  const ltpOfRow = useCallback(
    (row: DeployRow) => props.quotes[row.symbol] ?? chainLtp(props.chain, row.symbol),
    [props.quotes, props.chain]
  )
  const sizing = useMemo<Sizing>(
    () => ({ capital: props.capital, ltpOf: ltpOfRow }),
    [props.capital, ltpOfRow]
  )
  const constructed = props.rows.filter((row) => row.constructed).length
  const weightSum = props.rows
    .filter((row) => row.enabled)
    .reduce((sum, row) => sum + row.weight, 0)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 px-1.5 py-0.5 text-[9px] text-muted-foreground">
        <span className={cn('font-semibold', props.side === 'CE' ? 'text-emerald-600' : 'text-red-600')}>
          {props.side === 'CE' ? 'CALLS' : 'PUTS'}
        </span>
        {props.atm != null && <span className="font-mono">ATM {props.atm}</span>}
        <span className="font-mono" title="The side's weight shares sum to 100">
          Σ {Math.round(weightSum * 10) / 10}%
        </span>
        {constructed > 0 && (
          <span className="ml-auto truncate" title="Rows still on the OpenAlgo symbol convention — the chain snapshot swaps in the exact listed symbols when it lands">
            {constructed} resolving…
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.rows.length === 0 && (
          <p className="p-2 text-center text-[10px] text-muted-foreground">
            Add {props.side} strikes from the strip above.
          </p>
        )}
        {props.rows.map((row) => (
          <DeployRowItem
            key={row.symbol}
            row={row}
            ltp={ltpOfRow(row)}
            accent={strikeAccent(props.side, props.atm != null && props.interval ? (row.strike - props.atm) / props.interval : null)}
            offsetLabel={sideOffsetLabel(row, props.atm, props.interval)}
            capital={props.capital}
            pnl={rowPnl(row, props.positions, sizing)}
            inChart={props.chartSymbol === row.symbol}
            hasPosition={props.positions.has(`${row.exchange}:${row.symbol}`)}
            hasOrder={props.orderKeys.has(`${row.exchange}:${row.symbol}`)}
            targetHit={row.target != null && ltpOfRow(row) != null && ltpOfRow(row)! >= row.target}
            stopHit={row.stoploss != null && ltpOfRow(row) != null && ltpOfRow(row)! <= row.stoploss}
            collapsed={props.collapsed.has(row.symbol)}
            onToggleCollapse={() => props.onToggleCollapse(row.symbol)}
            onToggle={() => props.onToggle(row.symbol)}
            onWeight={(value) => props.onWeight(row.symbol, value)}
            onLevels={(levels) => props.onLevels(row.symbol, levels)}
            onRemove={() => props.onRemove(row.symbol)}
            onFire={(action) => props.onFire(row.symbol, action)}
            onExit={() => props.onExit(row.symbol)}
            onChart={() => props.onChart(row)}
          />
        ))}
      </div>
    </div>
  )
}
