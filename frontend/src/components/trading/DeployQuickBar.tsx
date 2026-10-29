/**
 * The Deploy panel's quick buttons, parked above the bottom dock.
 *
 * The panel is a working surface — its ladder, its chain poll, its strike
 * picker — and the buttons used to live at its bottom edge, reachable only
 * while the panel stood open. This bar carries the same buttons the rest of
 * the time: a stable strip the whole page width, always above the dock, so
 * Deploy CE / Close CE / Exit All are one press at any moment without
 * opening anything.
 *
 * It owns no polls. Every figure it fires on — positions, funds, the rows'
 * live quotes — is fetched at press time, in one parallel breath, the way a
 * trader's own click wants fresh numbers rather than a cached set; between
 * presses the bar costs the feed nothing, which is also why it can sit
 * beside the panel without doubling a single standing request. Both read and
 * write the same persisted deploy book (oa-trading-deploy-v1), so a ladder
 * built in the panel fires here, and a close fired here shows in the panel
 * the next time the trader opens it.
 *
 * The Strategy bots button on the right opens the rail's Strategy panel —
 * the bar is the two quick surfaces' shared front door.
 */

import { Bot, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { tradingApi } from '@/api/trading'
import { Button } from '@/components/ui/button'
import { constituentsFor } from '@/lib/hedging/indexConstituents'
import { planBracket } from '@/lib/trading/bracket'
import {
  bookKey,
  type DeployRow,
  firingRows,
  fnoBaseSymbol,
  readDeployState,
  usableSessionCapital,
  writeDeployState,
} from '@/lib/trading/deployPlan'
import { currentOrderMode, resolveOrderPricing } from '@/lib/trading/orderMode'
import { cn } from '@/lib/utils'
import { FNO_UNDERLYING_EXCHANGES, fnoExchangeFor } from '@/types/hedging'
import type { Position } from '@/types/trading'
import { showToast } from '@/utils/toast'

/** How often the persisted book is re-read: the ladder may have moved. */
const BOOK_POLL_MS = 2000

/** One order the bar places — the panel's PanelOrder, minus the levels a bar never adds. */
interface BarOrder {
  symbol: string
  exchange: string
  action: 'BUY' | 'SELL'
  quantity: number
  entry?: number | null
  ltp?: number | null
  target?: number | null
  stoploss?: number | null
}

type BusyKey = 'deployCE' | 'deployPE' | 'closeCE' | 'closePE' | 'exitAll' | 'buyAll' | 'sellAll'

const NO_BUSY: Record<BusyKey, boolean> = {
  deployCE: false,
  deployPE: false,
  closeCE: false,
  closePE: false,
  exitAll: false,
  buyAll: false,
  sellAll: false,
}

interface Props {
  apiKey: string
  /** True when trading is locked (a replay on screen), having said why. */
  refuse(): boolean
  /** Opens the rail's Strategy bots panel. */
  onOpenStrategy(): void
}

/** The bar's quiet width steps: buttons hug, the binding label truncates. */
const BTN = 'h-6 flex-1 min-w-0 gap-1 px-2 text-[10px] font-medium'

export function DeployQuickBar({ apiKey, refuse, onOpenStrategy }: Props) {
  const [busy, setBusy] = useState<Record<BusyKey, boolean>>(NO_BUSY)
  /** The persisted deploy book, re-read on a slow stride like IndexTab's binding. */
  const [state, setState] = useState(() => readDeployState())

  useEffect(() => {
    const read = () => setState(readDeployState())
    read()
    const timer = window.setInterval(read, BOOK_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  const workspace = state.workspace
  const underlying = workspace?.symbol ?? ''
  const optionsExchange = useMemo(
    () => fnoExchangeFor(workspace?.exchange ?? 'NSE'),
    [workspace?.exchange]
  )
  const ladder = state.books[bookKey(optionsExchange, underlying)] ?? { ce: [], pe: [] }
  // An index binding trades its option ladder; a stock binding trades the
  // equity list — the panel's own split, read from the same book.
  const indexUnderlying =
    FNO_UNDERLYING_EXCHANGES.has(workspace?.exchange ?? '') ||
    constituentsFor(fnoBaseSymbol(underlying)) != null
  const optionsMode = indexUnderlying || ladder.ce.length > 0 || ladder.pe.length > 0
  const stockRows = state.stocks

  /**
   * The fresh figures a press needs, in one breath: the book's symbols'
   * quotes, the broker's positions (a close flattens what is open, not what
   * the funds imagine), and the funds (a deploy sizes from them). No
   * standing poll — the bar's idle cost stays zero.
   */
  const fetchFireInputs = useCallback(
    async (symbols: Array<{ symbol: string; exchange: string }>) => {
      const quoteTargets = symbols.slice(0, 80)
      const [quotesRes, posRes, fundsRes] = await Promise.allSettled([
        quoteTargets.length > 0
          ? tradingApi.getMultiQuotes(
              apiKey,
              quoteTargets.map(({ symbol, exchange }) => ({ symbol, exchange }))
            )
          : Promise.resolve({ status: 'success' as const, results: [] }),
        tradingApi.getPositions(apiKey),
        tradingApi.getFunds(apiKey),
      ])
      const quotes: Record<string, number> = {}
      if (quotesRes.status === 'fulfilled') {
        for (const item of quotesRes.value.results ?? []) {
          if (item.data && Number.isFinite(item.data.ltp)) quotes[item.symbol] = item.data.ltp
        }
      }
      const positions = new Map<string, Position>()
      let day = 0
      let realized = 0
      if (posRes.status === 'fulfilled' && posRes.value.status === 'success') {
        for (const position of posRes.value.data ?? []) {
          const pnl = Number(position.pnl) || 0
          day += pnl
          if (Number(position.quantity) === 0) realized += pnl
          if (position.quantity !== 0)
            positions.set(`${position.exchange}:${position.symbol}`, position)
        }
      }
      const funds =
        fundsRes.status === 'fulfilled' && fundsRes.value.status === 'success'
          ? Number(fundsRes.value.data?.availablecash) || 0
          : 0
      return { quotes, positions, sessionPnl: { day, realized }, funds }
    },
    [apiKey]
  )

  /** The bracket watch a filled-later entry needs — the panel's own arm. */
  const armBracket = useCallback((order: BarOrder, product: 'MIS' | 'NRML' | 'CNC') => {
    if (order.target == null && order.stoploss == null) return
    const bracket = planBracket({
      symbol: order.symbol,
      exchange: order.exchange,
      action: order.action,
      quantity: order.quantity,
      product,
      entry: order.entry ?? null,
      target: order.target ?? null,
      stoploss: order.stoploss ?? null,
    })
    if (!bracket) return
    const fresh = readDeployState()
    writeDeployState({
      ...fresh,
      brackets: [
        ...fresh.brackets.filter(
          (candidate) =>
            !(
              candidate.stage === 'watch' &&
              candidate.symbol === order.symbol &&
              candidate.exchange === order.exchange
            )
        ),
        bracket,
      ],
    })
  }, [])

  const placeOrders = useCallback(
    async (orders: BarOrder[], product: 'MIS' | 'NRML' | 'CNC') => {
      let placed = 0
      let failed = 0
      let rested = 0
      const { mode, mppPercent } = currentOrderMode()
      for (const order of orders) {
        const pricing = resolveOrderPricing({
          action: order.action,
          mode,
          mppPercent,
          entry: order.entry,
          ltp: order.ltp,
        })
        try {
          const res = await tradingApi.placeOrder({
            apikey: apiKey,
            strategy: 'DEPLOY',
            exchange: order.exchange,
            symbol: order.symbol,
            action: order.action,
            quantity: order.quantity,
            pricetype: pricing.pricetype,
            product,
            price: pricing.price,
          })
          if (res.status === 'success') {
            placed += 1
            if (pricing.pricetype === 'LIMIT') rested += 1
            armBracket(order, product)
          } else failed += 1
        } catch {
          failed += 1
        }
      }
      if (rested > 0)
        showToast.info(
          `${rested} order${rested === 1 ? '' : 's'} resting LIMIT — target/SL attach the moment they fill`
        )
      return { placed, failed }
    },
    [apiKey, armBracket]
  )

  const report = useCallback((label: string, placed: number, failed: number) => {
    if (failed === 0)
      showToast.success(`${label}: ${placed} order${placed === 1 ? '' : 's'} placed`)
    else if (placed === 0) showToast.error(`${label}: every order failed`)
    else showToast.warning(`${label}: ${placed} placed, ${failed} failed`)
  }, [])

  /**
   * One press, end to end: refuse (replay) → fresh inputs → the plan → the
   * wire. The busy key holds the button's spinner; a second press on the
   * same key is dropped while it runs, other keys stay live. A plan that
   * sizes to nothing says so instead of firing nothing quietly.
   */
  const fire = useCallback(
    async (
      key: BusyKey,
      label: string,
      planFor: (inputs: {
        quotes: Record<string, number>
        positions: Map<string, Position>
        capital: number
      }) => BarOrder[]
    ) => {
      if (refuse()) return
      if (busy[key]) return
      setBusy((previous) => ({ ...previous, [key]: true }))
      try {
        const rows = optionsMode ? [...ladder.ce, ...ladder.pe] : stockRows
        const symbols = rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange }))
        const inputs = await fetchFireInputs(symbols)
        const capital = usableSessionCapital(state, inputs.funds, {
          dayPnl: inputs.sessionPnl.day,
          realizedPnl: inputs.sessionPnl.realized,
          // The bar keeps no session memory of its own — the panel's House
          // basis starts from its own "has a deploy run" flag, which lives
          // there. Every other basis reads the same figures either way.
          deployedOnce: false,
        })
        const planned = planFor({
          quotes: inputs.quotes,
          positions: inputs.positions,
          capital,
        }).filter((order) => order.quantity > 0)
        if (planned.length === 0) {
          showToast.warning(`${label}: nothing to place — no enabled row sizes to a quantity`)
          return
        }
        const { placed, failed } = await placeOrders(planned, state.product)
        report(label, placed, failed)
      } finally {
        setBusy((previous) => ({ ...previous, [key]: false }))
      }
    },
    [busy, refuse, optionsMode, ladder, stockRows, state, fetchFireInputs, placeOrders, report]
  )

  /** A deploy BUY sizes from the funds; a close flattens what is open. */
  const fireSide = useCallback(
    (action: 'BUY' | 'SELL', side: 'CE' | 'PE', key: BusyKey, label: string) =>
      void fire(key, label, ({ quotes, positions, capital }) => {
        const rows = ladder[side === 'CE' ? 'ce' : 'pe']
        const ltpOf = (row: DeployRow) => quotes[row.symbol]
        if (action === 'SELL') {
          return rows
            .filter((row) => row.enabled)
            .map((row) => {
              const pos = positions.get(`${row.exchange}:${row.symbol}`)
              const held = pos ? Math.abs(Number(pos.quantity) || 0) : 0
              return {
                symbol: row.symbol,
                exchange: row.exchange,
                action: (pos && pos.quantity > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
                quantity: held,
                ltp: ltpOf(row),
              }
            })
        }
        return firingRows(rows, { capital, ltpOf }).map(({ row, qty }) => ({
          symbol: row.symbol,
          exchange: row.exchange,
          action: 'BUY' as const,
          quantity: qty,
          entry: row.entry ?? null,
          target: row.target ?? null,
          stoploss: row.stoploss ?? null,
          ltp: ltpOf(row),
        }))
      }),
    [fire, ladder]
  )

  /** Exit All flattens every enabled row's open position, both sides. */
  const exitAll = useCallback(
    () =>
      void fire('exitAll', 'Exit All', ({ quotes, positions }) => {
        const rows = optionsMode ? [...ladder.ce, ...ladder.pe] : stockRows
        const ltpOf = (row: DeployRow) => quotes[row.symbol]
        return rows
          .filter((row) => row.enabled)
          .map((row) => {
            const pos = positions.get(`${row.exchange}:${row.symbol}`)
            const held = pos ? Math.abs(Number(pos.quantity) || 0) : 0
            return {
              symbol: row.symbol,
              exchange: row.exchange,
              action: (pos && pos.quantity > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
              quantity: held,
              ltp: ltpOf(row),
            }
          })
      }),
    [fire, optionsMode, ladder, stockRows]
  )

  /** The equity book's Buy/Sell All — funds-sized, the panel's fireStocks. */
  const fireStocks = useCallback(
    (action: 'BUY' | 'SELL', key: BusyKey, label: string) =>
      void fire(key, label, ({ quotes, capital }) => {
        const ltpOf = (row: DeployRow) => quotes[row.symbol]
        return firingRows(stockRows, { capital, ltpOf }).map(({ row, qty }) => ({
          symbol: row.symbol,
          exchange: row.exchange,
          action,
          quantity: qty,
          entry: row.entry ?? null,
          target: row.target ?? null,
          stoploss: row.stoploss ?? null,
          ltp: ltpOf(row),
        }))
      }),
    [fire, stockRows]
  )

  const btn = (key: BusyKey, label: string, tone: string, onPress: () => void, title?: string) => (
    <Button
      type="button"
      size="sm"
      className={cn(BTN, tone, 'text-white')}
      disabled={busy[key]}
      onClick={onPress}
      title={title ?? label}
    >
      {busy[key] && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {label}
    </Button>
  )

  const hasBook = optionsMode ? ladder.ce.length > 0 || ladder.pe.length > 0 : stockRows.length > 0

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t bg-muted/30 px-2 py-1">
      <span className="shrink-0 text-[10px] text-muted-foreground">
        Quick deploy
        {workspace && (
          <>
            {' · '}
            <span className="font-mono font-semibold text-foreground">{underlying}</span>
          </>
        )}
      </span>
      {hasBook ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {optionsMode ? (
            <>
              {btn('deployCE', 'Deploy CE', 'bg-emerald-600 hover:bg-emerald-700', () =>
                fireSide('BUY', 'CE', 'deployCE', 'Deploy CE')
              )}
              {btn('deployPE', 'Deploy PE', 'bg-emerald-600 hover:bg-emerald-700', () =>
                fireSide('BUY', 'PE', 'deployPE', 'Deploy PE')
              )}
              {btn('closeCE', 'Close CE', 'bg-red-600 hover:bg-red-700', () =>
                fireSide('SELL', 'CE', 'closeCE', 'Close CE')
              )}
              {btn('closePE', 'Close PE', 'bg-red-600 hover:bg-red-700', () =>
                fireSide('SELL', 'PE', 'closePE', 'Close PE')
              )}
            </>
          ) : (
            <>
              {btn('buyAll', 'Buy All', 'bg-emerald-600 hover:bg-emerald-700', () =>
                fireStocks('BUY', 'buyAll', 'Buy All')
              )}
              {btn('sellAll', 'Sell All', 'bg-red-600 hover:bg-red-700', () =>
                fireStocks('SELL', 'sellAll', 'Sell All')
              )}
            </>
          )}
          {btn('exitAll', 'Exit All', 'bg-amber-500 hover:bg-amber-600', () => exitAll())}
        </div>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          Bind an underlying in the Deploy panel and build its ladder — its quick buttons stand
          here.
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 shrink-0 gap-1 px-2 text-[10px]"
        onClick={onOpenStrategy}
        title="Open the Strategy bots panel"
      >
        <Bot className="h-3 w-3" />
        Strategy bots
      </Button>
    </div>
  )
}
