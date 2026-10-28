import { type LevelCross, levelCrosses } from '@/lib/hedging/indexLevels'
import { type DeployRow, firingRows, type Sizing } from '@/lib/trading/deployPlan'
import type { ScheduledDeployPlan, ScheduledOrder } from '@/types/hedging'

/**
 * The charting terminal's firing plan, pure: what a scheduled batch of this
 * page means when it comes due.
 *
 * The hedging terminal's batches act on its boards with capital sizing; this
 * page's act on its deploy ladder with the ladder's own lots. A batch armed
 * here carries a `deploy` plan that names the side, the verb and — where it
 * mattered at arm time — the exact strikes. The plan's `spot` names the
 * underlying whose ladder the batch belongs to (the engine resolves that to
 * a book key); its strikes read as a promise about scope, not a snapshot to
 * replay blindly: whatever the trader enabled or disabled since arming is
 * honored at fire time, and an empty strike list means "whatever that side
 * has enabled when it fires".
 */

export interface FireOrder {
  symbol: string
  exchange: string
  action: 'BUY' | 'SELL'
  quantity: number
  /**
   * A BUY entry rests at the row's level when the row carries one — the
   * open order the trader asked for, not a market print. SELL legs (the
   * exits, the leaving half of a swap) never carry it.
   */
  price?: number
  /** The row's levels riding a BUY entry, for the panel's bracket arming. */
  entry?: number | null
  target?: number | null
  stoploss?: number | null
}

/**
 * The entry fields a BUY order carries from a row — nothing on a SELL leg,
 * and nothing at all for a row without levels, so a plain order stays a
 * plain order on the wire.
 */
export function rowEntryFields(
  row: DeployRow
): Pick<FireOrder, 'price' | 'entry' | 'target' | 'stoploss'> {
  const fields: Pick<FireOrder, 'price' | 'entry' | 'target' | 'stoploss'> = {}
  if (row.entry != null) {
    fields.price = row.entry
    fields.entry = row.entry
  }
  if (row.target != null) fields.target = row.target
  if (row.stoploss != null) fields.stoploss = row.stoploss
  return fields
}

/** One underlying's ladder, the shape a book key holds. */
export type Ladder = { ce: DeployRow[]; pe: DeployRow[] }

/**
 * Orders a due batch places, from the ladder as it stands right now.
 *
 * - `exitAll` sells every enabled row, both sides — the ladder is long-only.
 * - `deployA`/`deployB`/`closeA`/`closeB` buy or sell the plan's side; with
 *   named strikes, only those strikes (the enabled ones among them); with an
 *   empty list, every enabled row of the side.
 * - Quantities read each row's own lots — a row the ladder carries without
 *   manual lots is sized by the panel's weight shares, and the engine fires
 *   only the rows it can size from the ladder alone.
 */
export function ladderFireOrders(
  ladder: Ladder | undefined,
  entry: Pick<ScheduledOrder, 'action'>,
  plan: ScheduledDeployPlan
): FireOrder[] {
  if (!ladder) return []
  const orders: FireOrder[] = []

  if (entry.action === 'exitAll') {
    for (const { row, qty } of firingRows([...ladder.ce, ...ladder.pe])) {
      orders.push({ symbol: row.symbol, exchange: row.exchange, action: 'SELL', quantity: qty })
    }
    return orders
  }

  const all = plan.side === 'CE' ? ladder.ce : ladder.pe
  const wanted =
    plan.strikes.length > 0 ? all.filter((row) => plan.strikes.includes(row.strike)) : all
  for (const { row, qty } of firingRows(wanted)) {
    orders.push({
      symbol: row.symbol,
      exchange: row.exchange,
      action: plan.optionAction,
      quantity: qty,
      ...(plan.optionAction === 'BUY' ? rowEntryFields(row) : {}),
    })
  }
  return orders
}

/**
 * A swap's orders: leave the side the trader is exiting first, then enter
 * the opposite side. The from side sells every enabled row (the ladder is
 * long-only, so leaving is always a SELL); the other side buys every
 * enabled row. Exits lead — the proceeds are the entry's room. Sizing runs
 * the same weight-share arithmetic the quick actions run.
 */
export function swapFireOrders(
  ladder: Ladder | undefined,
  fromSide: 'CE' | 'PE',
  sizing?: Sizing
): FireOrder[] {
  if (!ladder) return []
  const leaving = fromSide === 'CE' ? ladder.ce : ladder.pe
  const entering = fromSide === 'CE' ? ladder.pe : ladder.ce
  const orders: FireOrder[] = []
  for (const { row, qty } of firingRows(leaving, sizing)) {
    orders.push({ symbol: row.symbol, exchange: row.exchange, action: 'SELL', quantity: qty })
  }
  for (const { row, qty } of firingRows(entering, sizing)) {
    orders.push({
      symbol: row.symbol,
      exchange: row.exchange,
      action: 'BUY',
      quantity: qty,
      ...rowEntryFields(row),
    })
  }
  return orders
}

/**
 * The deploy plan a batch armed from the Scheduled popup carries: the side
 * and verb it will run against the ladder, and the strikes that side had
 * enabled when it was armed (empty = the side's enabled rows at fire time).
 */
export function planForLadderBatch(input: {
  action: ScheduledOrder['action']
  side: 'CE' | 'PE'
  spot: { symbol: string; exchange: string } | null
  enabledStrikes: number[]
}): ScheduledDeployPlan {
  return {
    side: input.side,
    strikes: input.enabledStrikes,
    optionAction: input.action.startsWith('deploy') ? 'BUY' : 'SELL',
    target: null,
    stop: null,
    spot: input.spot,
  }
}

/** Where an index level closes the trade: profit cross and its opposite. */
export function planCrosses(plan: Pick<ScheduledDeployPlan, 'side' | 'optionAction'>): {
  target: LevelCross
  stop: LevelCross
} {
  return levelCrosses(plan.side, plan.optionAction)
}

/**
 * Whether the index entry level is already met at the given spot LTP — a
 * blank entry (or one the spot already crossed) places now instead of arming.
 */
export function entryMet(
  entry: number | null | undefined,
  crosses: { target: LevelCross },
  spotLtp: number | undefined
): boolean {
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return true
  if (spotLtp == null || !Number.isFinite(spotLtp)) return false
  return crosses.target === 'above' ? spotLtp >= entry : spotLtp <= entry
}

/**
 * Orders for an index-deploy plan's strikes, resolved against the ladder
 * first (rows carry the exact listed symbol and lot size) and the caller's
 * chain fallback second — a strike the chain no longer lists was never
 * tradable. Existing rows win so the trader's per-row lots are honored.
 */
export function planFireOrders(
  ladder: Ladder | undefined,
  batchLots: number,
  plan: ScheduledDeployPlan,
  fallbackRows: DeployRow[]
): FireOrder[] {
  const byStrike = new Map<number, DeployRow>()
  for (const row of [
    ...(ladder ? (plan.side === 'CE' ? ladder.ce : ladder.pe) : []),
    ...fallbackRows,
  ]) {
    if (row.optionType !== plan.side) continue
    if (!byStrike.has(row.strike)) byStrike.set(row.strike, row)
  }
  const orders: FireOrder[] = []
  for (const strike of plan.strikes) {
    const row = byStrike.get(strike)
    if (!row) continue
    const qty = (row.lots || batchLots) * row.lotSize
    if (qty <= 0) continue
    orders.push({
      symbol: row.symbol,
      exchange: row.exchange,
      action: plan.optionAction,
      quantity: qty,
    })
  }
  return orders
}
