import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMarketData } from '@/hooks/useMarketData'
import { optionChainApi } from '@/api/option-chain'
import { scalpingApi } from '@/api/scalping'
import { tradingApi } from '@/api/trading'
import { useEngineLock } from '@/lib/hedging/engineLock'
import { isDue, istDateKey, scheduleActionLabel } from '@/lib/hedging/scheduler'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import { rowsFromStrikes, readDeployState } from '@/lib/trading/deployPlan'
import { ladderFireOrders, planFireOrders, type FireOrder } from '@/lib/trading/tradingFire'
import { fnoExchangeFor, type HedgingState, type ScheduledOrder } from '@/types/hedging'
import { showToast } from '@/utils/toast'

/**
 * The charting terminal's scheduler engine: it fires the batches this page
 * armed, against the deploy ladder this page keeps.
 *
 * The store is shared with the hedging terminal, so every row is stamped
 * with its origin and this engine touches only its own — a batch armed on
 * the hedging page still waits for that page's engine, which alone knows
 * its boards. Ticking every second while the trading page is open, it
 * claims a cross-tab lock first (two tabs of this page must not both
 * fire), marks a due row done in the store before placing anything, and
 * remembers what it fired for the day so a stale write can never resurrect
 * a batch into a second fill.
 *
 * LTPs for price triggers ride the page's websocket feed: the engine
 * subscribes to exactly the symbols the pending rows watch.
 */
export function useTradingScheduler(apiKey: string) {
  const claimLock = useEngineLock('trading')

  /** The distinct price-trigger symbols the pending batches watch. */
  const [triggerSymbols, setTriggerSymbols] = useState<
    Array<{ symbol: string; exchange: string }>
  >([])
  const triggerKey = useMemo(
    () => triggerSymbols.map((pick) => `${pick.exchange}:${pick.symbol}`).sort().join('|'),
    [triggerSymbols]
  )
  const quoteSymbols = useMemo(
    () =>
      triggerKey.split('|').filter(Boolean).map((key) => {
        const [exchange, symbol] = key.split(':')
        return { symbol, exchange }
      }),
    [triggerKey]
  )
  const quotes = useMarketData({ symbols: quoteSymbols, mode: 'LTP' })
  const quotesRef = useRef(quotes)
  quotesRef.current = quotes

  // The store is the truth; a two-second scan keeps the subscription list
  // exactly as wide as the pending batches make it.
  useEffect(() => {
    const scan = () => {
      const next = new Map<string, { symbol: string; exchange: string }>()
      for (const entry of loadHedgingState().scheduled) {
        if (entry.status !== 'pending' || entry.origin !== 'trading') continue
        if (entry.trigger.kind === 'price') {
          next.set(`${entry.trigger.exchange}:${entry.trigger.symbol}`, {
            symbol: entry.trigger.symbol,
            exchange: entry.trigger.exchange,
          })
        }
      }
      setTriggerSymbols((current) => {
        const currentKey = current.map((p) => `${p.exchange}:${p.symbol}`).sort().join('|')
        const nextKey = [...next.keys()].sort().join('|')
        return currentKey === nextKey ? current : [...next.values()]
      })
    }
    scan()
    const timer = window.setInterval(scan, 2000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * A row's batch: one market order per strike the plan names, read from
   * the ladder as it stands right now (the trader's enabled flags and
   * per-row lots are honored). Strikes the ladder dropped since arming
   * resolve through the live chain before anything is placed — and an
   * empty plan says so instead of placing silence.
   */
  const fire = useCallback(
    async (entry: ScheduledOrder) => {
      const plan = entry.deploy
      if (!plan?.spot?.symbol) {
        showToast.warning(`${label(entry)}: the row does not name its ladder — nothing fired.`)
        return
      }
      const optionsExchange = plan.exchange ?? fnoExchangeFor('NSE')
      const key = `${optionsExchange}:${plan.spot.symbol}`
      const state = readDeployState()
      const ladder = state.books[key]
      let orders: FireOrder[] = ladderFireOrders(ladder, entry, plan)
      if (plan.strikes.length > 0) {
        const sideRows = plan.side === 'CE' ? (ladder?.ce ?? []) : (ladder?.pe ?? [])
        const missing = plan.strikes.filter(
          (strike) => !sideRows.some((row) => row.strike === strike)
        )
        if (missing.length > 0) {
          const fallback = await resolveStrikes(
            apiKey,
            plan.spot.symbol,
            optionsExchange,
            plan.side,
            missing
          )
          // The plan is the armed intent: its strikes fire even where the
          // ladder's checkbox has since been cleared — the merge adds only
          // rows the ladder does not already cover.
          orders = mergeOrders(orders, planFireOrders(ladder, state.lots, plan, fallback))
        }
      }
      if (orders.length === 0) {
        showToast.warning(`${label(entry)}: no enabled ${plan.side} strikes to fire.`)
        return
      }
      let placed = 0
      let failed = 0
      for (const order of orders) {
        try {
          const res = await tradingApi.placeOrder({
            apikey: apiKey,
            strategy: 'SCHEDULED',
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
      if (failed === 0)
        showToast.success(`${label(entry)}: ${placed} order${placed === 1 ? '' : 's'} placed`)
      else if (placed === 0) showToast.error(`${label(entry)}: every order failed`)
      else showToast.warning(`${label(entry)}: ${placed} placed, ${failed} failed`)
    },
    [apiKey]
  )
  const fireRef = useRef(fire)
  fireRef.current = fire

  /** Rows this instance already fired today — a resurrected row stays dead. */
  const firedRef = useRef(new Set<string>())

  useEffect(() => {
    if (!apiKey) return
    const timer = window.setInterval(() => {
      if (!claimLock()) return
      const now = new Date()
      const dayKey = istDateKey(now)
      for (const entry of loadHedgingState().scheduled) {
        if (entry.status !== 'pending' || entry.origin !== 'trading') continue
        const firedKey = `${entry.id}:${dayKey}`
        if (firedRef.current.has(firedKey)) continue
        const due = isDue(entry, {
          now,
          ltpOf: (symbol, exchange) =>
            quotesRef.current.data.get(`${exchange}:${symbol}`)?.data?.ltp,
        })
        if (!due) continue
        // Mark in the shared store before placing anything: a reader in
        // another tab sees a done row, not a due one about to fire twice.
        const fresh = loadHedgingState()
        const row = fresh.scheduled.find((candidate) => candidate.id === entry.id)
        if (!row || row.status !== 'pending') continue
        const daily = row.trigger.kind === 'time' && row.trigger.repeat === 'daily'
        const marked = markRow(fresh, entry.id, daily, now.getTime())
        if (!marked) continue
        firedRef.current.add(firedKey)
        void fireRef.current(entry)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [apiKey, claimLock])
}

/** Write a due row's audit stamp through a fresh read, true when saved. */
function markRow(
  state: HedgingState,
  id: string,
  daily: boolean,
  firedAt: number
): boolean {
  try {
    saveHedgingState({
      ...state,
      scheduled: state.scheduled.map((candidate) =>
        candidate.id === id
          ? daily
            ? { ...candidate, firedAt }
            : { ...candidate, status: 'done' as const, firedAt }
          : candidate
      ),
    })
    return true
  } catch {
    return false
  }
}

function label(entry: ScheduledOrder): string {
  return `Scheduled ${scheduleActionLabel(entry.action, entry.modeAtCreation, entry.target)}`
}

/** Resolve exact rows for strikes the ladder dropped, through the live chain. */
async function resolveStrikes(
  apiKey: string,
  underlying: string,
  exchange: string,
  side: 'CE' | 'PE',
  strikes: number[]
): Promise<ReturnType<typeof rowsFromStrikes>['rows']> {
  try {
    const expiries = await scalpingApi.getExpiry(underlying, exchange, 'options')
    const expiry = (expiries.data ?? [])[0]
    if (!expiry) return []
    const chain = await optionChainApi.getOptionChain(apiKey, underlying, exchange, expiry, 50)
    if (chain.status !== 'success') return []
    return rowsFromStrikes(chain, side, strikes, [], exchange).rows
  } catch {
    return []
  }
}

/** First-seen wins, so rows the ladder already carries keep their lots. */
function mergeOrders(base: FireOrder[], extra: FireOrder[]): FireOrder[] {
  const seen = new Set(base.map((order) => order.symbol))
  return [...base, ...extra.filter((order) => !seen.has(order.symbol))]
}
