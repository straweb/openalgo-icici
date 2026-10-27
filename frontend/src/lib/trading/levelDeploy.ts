import { newScheduleId } from '@/lib/hedging/scheduler'
import { rowsFromStrikes, type DeployRow } from '@/lib/trading/deployPlan'
import { entryMet, planCrosses } from '@/lib/trading/tradingFire'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import type { ScheduledOrder } from '@/types/hedging'
import type { OptionChainResponse } from '@/types/option-chain'
import { tradingApi } from '@/api/trading'
import { strikesForPick, type StrikePickMode } from '@/lib/hedging/indexLevels'
import { showToast } from '@/utils/toast'

/**
 * Deploy-by-level for the charting terminal's Deploy panel — the same verb
 * the dock's Index tab runs, expressed so the panel (which owns its own
 * chain snapshot and ladder state) can drive it.
 *
 * The plan's strikes land in the ladder first (visible, adjustable), then
 * the verb runs: an entry already met — or none — places now and arms the
 * close rows on the spot index; an entry ahead parks spot-price trigger
 * rows this page's engine fires. Either way the picked strikes end up in
 * the ladder where the trader can see and adjust them.
 */

export interface LevelPick {
  side: 'CE' | 'PE'
  optionAction: 'BUY' | 'SELL'
  pick: { mode: StrikePickMode; count?: number; strikes?: number[] }
  entry?: number | null
  target?: number | null
  stop?: number | null
}

export interface ResolvedLevel {
  rows: DeployRow[]
  picked: DeployRow[]
  skipped: number[]
  planned: number[]
  atm: number | null
}

/** Resolve a level pick against the chain into ladder rows. */
export function resolveLevelPick(input: {
  chain: Pick<OptionChainResponse, 'chain' | 'atm_strike' | 'underlying_ltp'> | null
  interval: number
  plan: LevelPick
  existing: DeployRow[]
  optionsExchange: string
}): ResolvedLevel | null {
  if (!input.chain) return null
  const atm =
    input.chain.atm_strike ||
    (input.interval ? Math.round((input.chain.underlying_ltp ?? 0) / input.interval) * input.interval : null)
  const planned = strikesForPick(input.plan.pick, atm, input.interval)
  const { rows, skipped } = rowsFromStrikes(
    input.chain,
    input.plan.side,
    planned,
    input.existing,
    input.optionsExchange
  )
  const picked = rows.filter(
    (row) => row.optionType === input.plan.side && planned.includes(row.strike)
  )
  return { rows, picked, skipped, planned, atm }
}

/** The deploy plan a level submission carries: side, verb, strikes, levels. */
export function buildDeployPlan(input: {
  plan: LevelPick
  picked: DeployRow[]
  spot: { symbol: string; exchange: string } | null
  optionsExchange: string
}): NonNullable<ScheduledOrder['deploy']> {
  return {
    side: input.plan.side,
    strikes: input.picked.map((row) => row.strike),
    optionAction: input.plan.optionAction,
    target: input.plan.target ?? null,
    stop: input.plan.stop ?? null,
    spot: input.spot,
    exchange: input.optionsExchange,
  }
}

/** Place the picked strikes now; returns how many landed. */
export async function placeLevelOrders(input: {
  apiKey: string
  picked: DeployRow[]
  batchLots: number
  optionAction: 'BUY' | 'SELL'
  product: 'MIS' | 'NRML' | 'CNC'
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
}): Promise<{ placed: number; failed: number }> {
  let placed = 0
  let failed = 0
  for (const row of input.picked) {
    const qty = (row.lots || input.batchLots) * row.lotSize
    if (qty <= 0) continue
    try {
      const res = await tradingApi.placeOrder({
        apikey: input.apiKey,
        strategy: 'DEPLOY',
        exchange: row.exchange,
        symbol: row.symbol,
        action: input.optionAction,
        quantity: qty,
        pricetype: input.pricetype,
        product: input.product,
      })
      if (res.status === 'success') placed += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { placed, failed }
}

/** Arm the target/stop close rows on the spot index after a placed deploy. */
export function armCloseRows(
  plan: NonNullable<ScheduledOrder['deploy']>,
  spot: { symbol: string; exchange: string } | null
): void {
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
      .map((row) => row.trigger.kind === 'price' ? `${row.trigger.condition === 'above' ? '≥' : '≤'} ${row.trigger.price.toLocaleString('en-IN')}` : '')
      .filter(Boolean)
      .join(' · ')}.`
  )
}

/** Whether the level deploy places now (entry met or blank) — the shared guard. */
export function levelEntryMet(plan: LevelPick, spotLtp: number | undefined): boolean {
  const crosses = planCrosses({ side: plan.side, optionAction: plan.optionAction })
  return entryMet(plan.entry, crosses, spotLtp)
}
