/**
 * The Constituents tab (the tab the charting terminal once called Index),
 * from the hedging terminal: the underlying's cash-market members, live,
 * plus its deploy dialog wired to this page's ladder.
 *
 * Which index it follows is decided without the chain snapshot: the deploy
 * panel's binding first, then the focused chart, then any other open chart
 * — the first candidate whose FNO base has a constituent set wins. A trader
 * charting `NSE_INDEX:NIFTY` (no options of its own to read) or a NIFTY CE
 * still lands on the Nifty 50 table.
 *
 * The spot quote is a quotes-feed poll over the index exchanges, so the
 * table works whether or not the broker's master contract carries the
 * index's options. Only the level deploy waits for the chain snapshot —
 * it needs the listed strikes — and it says so without hiding the table.
 */

import { Rocket } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { tradingApi } from '@/api/trading'
import { IndexDeployDialog, type IndexDeploySubmit } from '@/components/hedging/IndexDeployDialog'
import { IndexPanel } from '@/components/hedging/IndexPanel'
import { useSpotResolution } from '@/components/trading/dock/useSpotResolution'
import { Button } from '@/components/ui/button'
import { constituentsFor } from '@/lib/hedging/indexConstituents'
import { strikesForPick } from '@/lib/hedging/indexLevels'
import { newScheduleId, scheduleTriggerLabel } from '@/lib/hedging/scheduler'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import {
  chainLtp,
  fnoBaseSymbol,
  readDeployState,
  rowsFromStrikes,
  writeDeployState,
} from '@/lib/trading/deployPlan'
import { currentOrderMode, resolveOrderPricing } from '@/lib/trading/orderMode'
import type { SearchRow } from '@/lib/trading/terminal'
import { entryMet, planCrosses } from '@/lib/trading/tradingFire'
import type { ScheduledOrder } from '@/types/hedging'
import { fnoExchangeFor } from '@/types/hedging'
import { showToast } from '@/utils/toast'

interface Props {
  apiKey: string
  /** The focused pane's `EXCHANGE:SYMBOL` — one candidate for the index. */
  activeSymbol: string | null
  /** Every open pane's `EXCHANGE:SYMBOL` — the other candidates. */
  paneSymbols: Record<string, string | null>
  /** Charts a row in the focused pane, the way a watchlist row does. */
  onPick(row: SearchRow): void
}

const SPOT_POLL_MS = 4000
const BINDING_POLL_MS = 15000

/** The symbol half of a pane key (`NSE:NIFTY` → `NIFTY`). */
function symbolOf(key: string | undefined | null): string | null {
  if (!key) return null
  const at = key.indexOf(':')
  return at >= 0 ? key.slice(at + 1) : key
}

export function IndexTab({ apiKey, activeSymbol, paneSymbols, onPick }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false)
  /**
   * The deploy panel's binding moves on its own, with no event this tab
   * could hear — so the persisted book is re-read on a slow stride (it is
   * one small localStorage read), plus on every chart and mount change.
   */
  const [bindingSymbol, setBindingSymbol] = useState<string | null>(() => {
    const binding = readDeployState().workspace
    return binding ? binding.symbol : null
  })
  useEffect(() => {
    const read = () => {
      const binding = readDeployState().workspace
      setBindingSymbol(binding ? binding.symbol : null)
    }
    read()
    const timer = window.setInterval(read, BINDING_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  /** The index whose constituents show: first candidate with a member list. */
  const index = useMemo(() => {
    const candidates = [
      bindingSymbol,
      symbolOf(activeSymbol),
      ...Object.values(paneSymbols).map(symbolOf),
    ]
    for (const candidate of candidates) {
      if (!candidate) continue
      const base = fnoBaseSymbol(candidate)
      if (constituentsFor(base)) return base
    }
    // Nothing with a member set: keep the focused chart's base so the empty
    // state can say which underlying it looked for.
    return symbolOf(activeSymbol) ? fnoBaseSymbol(symbolOf(activeSymbol)!) : null
  }, [bindingSymbol, activeSymbol, paneSymbols])

  const profile = constituentsFor(index ?? '')
  const optionsExchange = profile ? fnoExchangeFor(profile.stockExchange) : 'NFO'

  // A level deploy wants the ladder around ATM, not a spot answer only —
  // this is the one read that waits for the chain snapshot.
  const {
    chain,
    spot: chainSpot,
    error,
  } = useSpotResolution(apiKey, index, 50, profile?.stockExchange ?? 'NSE')

  /** The spot quote, off the quotes feed — never waiting for the chain. */
  const [spotQuote, setSpotQuote] = useState<{ exchange: string; ltp: number | undefined } | null>(
    null
  )
  useEffect(() => {
    if (!index || !profile) {
      setSpotQuote(null)
      return
    }
    let alive = true
    const candidates = [
      `${profile.stockExchange}_INDEX`,
      profile.stockExchange,
      ...(profile.stockExchange === 'NSE' ? ['NSE_INDEX', 'NSE'] : ['BSE_INDEX', 'BSE']),
    ]
    const poll = async () => {
      for (const exchange of candidates) {
        try {
          const res = await tradingApi.getQuotes(apiKey, index, exchange)
          if (res.status === 'success' && Number.isFinite(res.data?.ltp)) {
            if (alive) setSpotQuote({ exchange, ltp: res.data!.ltp })
            return
          }
        } catch {
          // the next candidate exchange tries on
        }
        if (!alive) return
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), SPOT_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [apiKey, index, profile])

  const spot = useMemo(() => {
    if (spotQuote) return { symbol: index ?? '', exchange: spotQuote.exchange }
    if (chainSpot) return chainSpot
    return null
  }, [spotQuote, chainSpot, index])

  /** The strike interval, read the way the Deploy panel reads its own. */
  const interval = useMemo(() => {
    const strikes = chain?.chain.map((row) => row.strike) ?? []
    if (strikes.length < 2) return 0
    const sorted = [...new Set(strikes)].sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((s, i) => s - sorted[i])
    return Math.min(...gaps.filter((g) => g > 0)) || 0
  }, [chain])

  /**
   * The plan's strikes land in the ladder (visible, adjustable), then the
   * verb runs: an entry already met places now and arms the close rows; an
   * entry ahead arms a spot-price trigger this page's engine fires.
   */
  const submitDeploy = useCallback(
    async (plan: IndexDeploySubmit) => {
      if (!index || !chain) {
        showToast.warning('The chain snapshot has not landed — nothing to deploy yet.')
        return
      }
      const atm =
        chain.atm_strike ||
        (interval ? Math.round(chain.underlying_ltp / interval) * interval : null)
      const planned = strikesForPick(plan.pick, atm, interval)
      if (planned.length === 0) {
        showToast.warning('No strikes resolved for that pick.')
        return
      }
      // Into the ladder first: the trader sees exactly what is armed.
      const state = readDeployState()
      const key = `${optionsExchange}:${index}`
      const ladder = state.books[key] ?? { ce: [], pe: [] }
      const existing = plan.side === 'CE' ? ladder.ce : ladder.pe
      const { rows: next, skipped } = rowsFromStrikes(
        chain,
        plan.side,
        planned,
        existing,
        optionsExchange
      )
      writeDeployState({
        ...state,
        books: { ...state.books, [key]: { ...ladder, [plan.side === 'CE' ? 'ce' : 'pe']: next } },
      })
      if (skipped.length > 0)
        showToast.warning(
          `${plan.side}: ${skipped.length} of ${planned.length} strikes are not on the chain — the rest deployed.`
        )
      const picked = next.filter(
        (row) => row.optionType === plan.side && planned.includes(row.strike)
      )
      if (picked.length === 0) {
        showToast.warning('Those strikes are not on the chain — nothing to deploy.')
        return
      }
      const spotLtp = chain.underlying_ltp
      const crosses = planCrosses({ side: plan.side, optionAction: plan.optionAction })
      const deployPlan: NonNullable<ScheduledOrder['deploy']> = {
        side: plan.side,
        strikes: picked.map((row) => row.strike),
        optionAction: plan.optionAction,
        target: plan.target ?? null,
        stop: plan.stop ?? null,
        spot,
        exchange: optionsExchange,
      }
      if (entryMet(plan.entry, crosses, spotLtp)) {
        let placed = 0
        let failed = 0
        const { mode, mppPercent } = currentOrderMode()
        for (const row of picked) {
          const qty = (row.lots || state.lots) * row.lotSize
          if (qty <= 0) continue
          // The global order mode prices these too: an index deploy's strikes
          // carry no entry levels of their own, so LIMIT/LIVE rest at the
          // option's live price and MPP buffers it by the percent.
          const pricing = resolveOrderPricing({
            action: plan.optionAction,
            mode,
            mppPercent,
            ltp: chainLtp(chain, row.symbol),
          })
          try {
            const res = await tradingApi.placeOrder({
              apikey: apiKey,
              strategy: 'DEPLOY',
              exchange: row.exchange,
              symbol: row.symbol,
              action: plan.optionAction,
              quantity: qty,
              pricetype: pricing.pricetype,
              product: state.product,
              price: pricing.price,
            })
            if (res.status === 'success') placed += 1
            else failed += 1
          } catch {
            failed += 1
          }
        }
        if (placed === 0) {
          showToast.error('Index deploy: every order failed')
          return
        }
        showToast.success(
          `Index deploy: ${placed} order${placed === 1 ? '' : 's'} placed${failed > 0 ? `, ${failed} failed` : ''}`
        )
        armCloseRows(deployPlan, spot)
        return
      }
      if (!spot) {
        showToast.error('The spot symbol is not known yet — cannot arm an index trigger.')
        return
      }
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
        deploy: deployPlan,
      }
      const hedging = loadHedgingState()
      saveHedgingState({ ...hedging, scheduled: [...hedging.scheduled, row] })
      showToast.info(
        `Set: ${plan.optionAction} ${plan.side} ×${deployPlan.strikes.length} when ${spot.symbol} ${crosses.target === 'above' ? '≥' : '≤'} ${(plan.entry as number).toLocaleString('en-IN')}. It fires this page's deploy ladder.`
      )
    },
    [index, apiKey, chain, interval, spot, optionsExchange]
  )

  if (!index) {
    return (
      <p className="p-4 text-center text-[12px] text-muted-foreground">
        Chart an index, one of its options, or bind one in the Deploy panel to break it into its
        constituents.
      </p>
    )
  }
  if (!profile) {
    return (
      <p className="p-4 text-center text-[12px] text-muted-foreground">
        No constituent set for <span className="font-mono">{index}</span>.
      </p>
    )
  }

  return (
    <div className="h-full min-h-0">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <span className="text-[10px] text-muted-foreground">
          Following <span className="font-mono font-semibold text-foreground">{index}</span>
          {spotQuote?.ltp != null && (
            <span className="ml-1 font-mono tabular-nums">
              · {spotQuote.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          )}
        </span>
        <Button
          size="sm"
          className="ml-auto h-6 gap-1 bg-emerald-600 px-2 text-[10px] text-white hover:bg-emerald-700"
          disabled={!chain}
          title={
            chain
              ? 'Deploy strikes by index level (entry, target, stop)'
              : 'Waiting for the chain snapshot — it lands when the master contract has the options'
          }
          onClick={() => setDialogOpen(true)}
        >
          <Rocket className="h-3 w-3" />
          Deploy by level
        </Button>
      </div>
      {error && !chain && (
        <p className="border-b bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
          Level deploy reads the chain snapshot; it lands when the broker's master contract has{' '}
          {index}'s options. The constituents below read the quotes feed and work regardless.
        </p>
      )}
      <div
        className={error && !chain ? 'h-[calc(100%-58px)] min-h-0' : 'h-[calc(100%-29px)] min-h-0'}
      >
        <IndexPanel
          underlying={index}
          indexSpot={spot}
          onLoadChart={(pick) =>
            onPick({ symbol: pick.symbol, exchange: pick.exchange, name: pick.name })
          }
        />
      </div>
      <IndexDeployDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        spot={spot}
        spotLtp={chain?.underlying_ltp ?? spotQuote?.ltp}
        atmStrike={chain?.atm_strike}
        strikeInterval={interval || undefined}
        ceShare={loadHedgingState().ceShare}
        capitalNote="Quantity: the Deploy panel's batch lots × each strike's lot size — the picked strikes land in the ladder, where per-row lots can be set. Triggers run while this page stays open."
        onSubmit={(plan) => void submitDeploy(plan)}
      />
    </div>
  )
}

/** Arm the target/stop close rows on the spot index after a placed deploy. */
function armCloseRows(
  plan: NonNullable<ScheduledOrder['deploy']>,
  spot: { symbol: string; exchange: string } | null
) {
  if (!spot || !plan.spot) return
  const crosses = planCrosses({ side: plan.side, optionAction: plan.optionAction })
  const closeAction = plan.side === 'CE' ? ('closeA' as const) : ('closeB' as const)
  const rows: ScheduledOrder[] = []
  const mk = (kind: 'target' | 'stop') => {
    const level = kind === 'target' ? plan.target : plan.stop
    if (level == null || !Number.isFinite(level) || level <= 0) return
    rows.push({
      id: newScheduleId(),
      action: closeAction,
      trigger: {
        kind: 'price',
        symbol: plan.spot!.symbol,
        exchange: plan.spot!.exchange,
        condition: kind === 'target' ? crosses.target : crosses.stop,
        price: level,
      },
      status: 'pending',
      createdAt: Date.now(),
      modeAtCreation: 'fno',
      target: 'options',
      origin: 'trading',
      deploy: {
        ...plan,
        optionAction: 'SELL',
        target: null,
        stop: null,
      },
    })
  }
  mk('target')
  mk('stop')
  if (rows.length === 0) return
  const state = loadHedgingState()
  saveHedgingState({ ...state, scheduled: [...state.scheduled, ...rows] })
  showToast.info(
    `Exits set on ${plan.spot.symbol}: ${rows
      .map((row) => scheduleTriggerLabel(row.trigger))
      .join(' · ')}.`
  )
}
