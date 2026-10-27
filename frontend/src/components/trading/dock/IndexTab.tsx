/**
 * The Index tab, from the charting terminal: the hedging terminal's
 * constituent breakdown, following the charted underlying — plus its
 * deploy dialog, wired to this page's ladder.
 *
 * The Deploy-by-level button is the hedging IndexDeployDialog: pick the
 * strikes (ATM, n above/below, or explicit), an optional index entry level,
 * and optional index target/stop. An entry already met — or none — places
 * now and arms the close rows; otherwise the plan arms as a spot-price
 * trigger this page's engine fires, placing exactly these strikes into the
 * deploy ladder. Either way the picked strikes land in the ladder where the
 * trader can see and adjust them.
 */

import { useCallback, useMemo, useState } from 'react'
import { Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IndexPanel } from '@/components/hedging/IndexPanel'
import {
  IndexDeployDialog,
  type IndexDeploySubmit,
} from '@/components/hedging/IndexDeployDialog'
import { useSpotResolution } from '@/components/trading/dock/useSpotResolution'
import { newScheduleId, scheduleTriggerLabel } from '@/lib/hedging/scheduler'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import type { SearchRow } from '@/lib/trading/terminal'
import { rowsFromStrikes, readDeployState, writeDeployState } from '@/lib/trading/deployPlan'
import { strikesForPick } from '@/lib/hedging/indexLevels'
import { entryMet, planCrosses } from '@/lib/trading/tradingFire'
import { fnoExchangeFor } from '@/types/hedging'
import type { ScheduledOrder } from '@/types/hedging'
import { tradingApi } from '@/api/trading'
import { showToast } from '@/utils/toast'

interface Props {
  apiKey: string
  /** The focused pane's symbol — the underlying whose constituents show. */
  activeSymbol: string | null
  /** Charts a row in the focused pane, the way a watchlist row does. */
  onPick(row: SearchRow): void
}

export function IndexTab({ apiKey, activeSymbol, onPick }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false)
  // A level deploy wants the ladder around ATM, not a spot answer only.
  const { chain, spot, error } = useSpotResolution(apiKey, activeSymbol, 50)

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
      if (!activeSymbol || !chain) {
        showToast.warning('The chain snapshot has not landed — nothing to deploy yet.')
        return
      }
      const optionsExchange = fnoExchangeFor('NSE')
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
      const key = `${optionsExchange}:${activeSymbol}`
      const ladder = state.books[key] ?? { ce: [], pe: [] }
      const existing = plan.side === 'CE' ? ladder.ce : ladder.pe
      const { rows: next, skipped } = rowsFromStrikes(chain, plan.side, planned, existing, optionsExchange)
      writeDeployState({
        ...state,
        books: { ...state.books, [key]: { ...ladder, [plan.side === 'CE' ? 'ce' : 'pe']: next } },
      })
      if (skipped.length > 0)
        showToast.warning(
          `${plan.side}: ${skipped.length} of ${planned.length} strikes are not on the chain — the rest deployed.`
        )
      const picked = next.filter((row) => row.optionType === plan.side && planned.includes(row.strike))
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
        for (const row of picked) {
          const qty = (row.lots || state.lots) * row.lotSize
          if (qty <= 0) continue
          try {
            const res = await tradingApi.placeOrder({
              apikey: apiKey,
              strategy: 'DEPLOY',
              exchange: row.exchange,
              symbol: row.symbol,
              action: plan.optionAction,
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
    [activeSymbol, apiKey, chain, interval, spot]
  )

  if (!activeSymbol) {
    return (
      <p className="p-4 text-center text-[12px] text-muted-foreground">
        Chart an underlying to break it into its constituents.
      </p>
    )
  }
  if (error && !chain) {
    return (
      <div className="p-4 text-center">
        <p className="text-[12px] text-muted-foreground">{error}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          The constituents and the level deploy both read the chain snapshot; it lands when the
          broker's master contract has the index's options.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0">
      <div className="flex items-center justify-end border-b px-2 py-1">
        <Button
          size="sm"
          className="h-6 gap-1 bg-emerald-600 px-2 text-[10px] text-white hover:bg-emerald-700"
          disabled={!chain}
          title="Deploy strikes by index level (entry, target, stop)"
          onClick={() => setDialogOpen(true)}
        >
          <Rocket className="h-3 w-3" />
          Deploy by level
        </Button>
      </div>
      <div className="h-[calc(100%-29px)] min-h-0">
        <IndexPanel
          underlying={activeSymbol}
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
        spotLtp={chain?.underlying_ltp}
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
