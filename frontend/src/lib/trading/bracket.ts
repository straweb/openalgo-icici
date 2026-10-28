import type { Order } from '@/types/trading'

/**
 * The bracket a deploy row's entry order carries: the open order the trader
 * asked for at the row's entry price, with the target and stop attached the
 * moment the entry fills.
 *
 * Why an engine at all: a resting LIMIT entry can fill minutes later, and
 * OpenAlgo's order API has no native bracket — so the panel arms a watch
 * per entry. The watch rides the deploy book (it survives a reload), polls
 * the order and position books, and the moment the entry fills it places
 * the target as a resting LIMIT and the stop as a resting SL-M on the
 * closing side. When the position goes flat again — one close filled, the
 * trader quit out, Exit All landed — the sibling close that is still
 * working gets cancelled, so nothing naked survives the trade.
 *
 * Pure here: `advanceBracket` reads the books and returns the next stage
 * plus what to place and cancel; the engine hook executes and persists.
 */

export type BracketStage = 'watch' | 'armed' | 'done'

export interface DeployBracket {
  id: string
  symbol: string
  exchange: string
  /** The entry side this bracket rides — the ladder's entries are BUYs. */
  action: 'BUY' | 'SELL'
  quantity: number
  product: 'MIS' | 'NRML' | 'CNC'
  /** The price the entry rested at; null = the entry went at the panel's price type. */
  entry: number | null
  target: number | null
  stoploss: number | null
  entryOrderid: string | null
  stage: BracketStage
  closeTarget: string | null
  closeStop: string | null
  /** Placement attempts the closes have burned — the engine caps the retries. */
  attempts?: number
  createdAt: number
}

/** One close order the engine should place now. */
export interface CloseOrderPlan {
  key: 'closeTarget' | 'closeStop'
  action: 'BUY' | 'SELL'
  pricetype: 'LIMIT' | 'SL-M'
  quantity: number
  price?: number
  trigger_price?: number
}

/** What a bracket wants done this tick: place closes, cancel strays, both, or nothing. */
export interface BracketDecision {
  bracket: DeployBracket
  place: CloseOrderPlan[]
  cancel: string[]
}

/** Order states that can still be pulled — the same set the row highlights read. */
export const WORKING_ORDER_STATES = ['open', 'pending', 'trigger pending']

export function newBracketId(): string {
  return `brk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * The bracket an entry order arms — null when the row carries neither a
 * target nor a stop, because there is nothing to attach. The entry price
 * rides along for the record whether the order rested at it or not.
 */
export function planBracket(input: {
  symbol: string
  exchange: string
  action: 'BUY' | 'SELL'
  quantity: number
  product: 'MIS' | 'NRML' | 'CNC'
  entry: number | null
  target: number | null
  stoploss: number | null
}): DeployBracket | null {
  if (input.target == null && input.stoploss == null) return null
  return {
    id: newBracketId(),
    symbol: input.symbol,
    exchange: input.exchange,
    action: input.action,
    quantity: input.quantity,
    product: input.product,
    entry: input.entry,
    target: input.target,
    stoploss: input.stoploss,
    entryOrderid: null,
    stage: 'watch',
    closeTarget: null,
    closeStop: null,
    attempts: 0,
    createdAt: Date.now(),
  }
}

/** The side that leaves the position the entry built. */
export function closingAction(action: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  return action === 'BUY' ? 'SELL' : 'BUY'
}

/**
 * One tick of the engine, pure. `orders` is the broker's order book (the
 * engine's own poll), `positionQty` the net signed quantity held for the
 * bracket's symbol, and `positionsKnown` says the position poll itself
 * succeeded — a blind tick never moves a bracket, because cancelling a
 * live hedge on a failed read is the one mistake this engine must not
 * make.
 */
export function advanceBracket(
  bracket: DeployBracket,
  ctx: { orders: Order[]; positionQty?: number; positionsKnown: boolean }
): BracketDecision {
  const next: DeployBracket = { ...bracket }

  if (bracket.stage === 'watch') {
    const entry = bracket.entryOrderid
      ? ctx.orders.find((order) => order.orderid === bracket.entryOrderid)
      : undefined
    if (!entry) return { bracket: next, place: [], cancel: [] }

    // A position on the entry's side is the truth of what is held — a
    // cancelled entry can still carry a partial fill.
    const held = heldQuantity(bracket, ctx.positionQty)
    const dead = entry.order_status === 'cancelled' || entry.order_status === 'rejected'

    if (entry.order_status !== 'complete' && !(dead && held > 0)) {
      // Still working (wait), or dead with nothing held (end here).
      if (dead && ctx.positionsKnown && held === 0) next.stage = 'done'
      return { bracket: next, place: [], cancel: [] }
    }
    // The entry filled (or died holding something). Without a position
    // truth this tick, wait for the next one rather than guess a size.
    if (!ctx.positionsKnown) return { bracket: next, place: [], cancel: [] }

    if (held === 0) {
      // Flat already: either the fill has not surfaced in the position
      // book yet, or the trade has come and gone. A closing-side order in
      // the book — the trader's own exit, working or filled — says gone;
      // anything else says a fill the position book has not caught up
      // with, and the closes go out (an over-place the armed stage
      // self-heals: flat + working closes get pulled).
      const exited = ctx.orders.some(
        (order) =>
          order.symbol === bracket.symbol &&
          order.exchange === bracket.exchange &&
          order.action === closingAction(bracket.action) &&
          (order.order_status === 'complete' || WORKING_ORDER_STATES.includes(order.order_status))
      )
      if (exited) {
        next.stage = 'done'
        return { bracket: next, place: [], cancel: [] }
      }
      return {
        bracket: { ...next, stage: 'armed' },
        place: closesFor(bracket, entry.quantity),
        cancel: [],
      }
    }

    return { bracket: { ...next, stage: 'armed' }, place: closesFor(bracket, held), cancel: [] }
  }

  if (bracket.stage === 'armed') {
    // Only a read that actually saw the position book may pull closes.
    if (!ctx.positionsKnown) return { bracket: next, place: [], cancel: [] }
    const held = heldQuantity(bracket, ctx.positionQty) > 0
    const closes = ctx.orders.filter(
      (order) => order.orderid === bracket.closeTarget || order.orderid === bracket.closeStop
    )
    if (held) {
      // The trader pulled both closes by hand while the position lives:
      // nothing left to manage, the position is theirs again.
      const anyWorking = closes.some((order) => WORKING_ORDER_STATES.includes(order.order_status))
      if (bracket.closeTarget && bracket.closeStop && !anyWorking) next.stage = 'done'
      return { bracket: next, place: [], cancel: [] }
    }
    // Flat again: pull every close of ours that is still working — the
    // filled one reads complete in the book and is left alone.
    const cancel = closes
      .filter((order) => WORKING_ORDER_STATES.includes(order.order_status))
      .map((order) => order.orderid)
    next.stage = 'done'
    return { bracket: next, place: [], cancel }
  }

  return { bracket: next, place: [], cancel: [] }
}

/** What the bracket's symbol holds on the entry's side, 0 when nothing. */
function heldQuantity(bracket: DeployBracket, positionQty: number | undefined): number {
  if (positionQty == null) return 0
  const onSide = bracket.action === 'BUY' ? positionQty > 0 : positionQty < 0
  return onSide ? Math.abs(positionQty) : 0
}

/** The closing orders a filled entry attaches: a LIMIT target, an SL-M stop. */
function closesFor(bracket: DeployBracket, qty: number): CloseOrderPlan[] {
  const place: CloseOrderPlan[] = []
  if (qty <= 0) return place
  const leave = closingAction(bracket.action)
  if (bracket.target != null) {
    place.push({
      key: 'closeTarget',
      action: leave,
      pricetype: 'LIMIT',
      quantity: qty,
      price: bracket.target,
    })
  }
  if (bracket.stoploss != null) {
    place.push({
      key: 'closeStop',
      action: leave,
      pricetype: 'SL-M',
      quantity: qty,
      trigger_price: bracket.stoploss,
    })
  }
  return place
}

/** Brackets that still need the engine — watch entries and armed closes. */
export function activeBrackets(brackets: DeployBracket[]): DeployBracket[] {
  return brackets.filter((bracket) => bracket.stage !== 'done')
}

/** Insert or replace a bracket in the book's list, newest last. */
export function upsertBracket(brackets: DeployBracket[], bracket: DeployBracket): DeployBracket[] {
  const without = brackets.filter((candidate) => candidate.id !== bracket.id)
  return [...without, bracket]
}

/**
 * The bracket list a persisted book hydrates to: shapes the validator
 * cannot trust drop silently, so one bad write never blocks the panel.
 */
export function hydrateBrackets(raw: unknown): DeployBracket[] {
  if (!Array.isArray(raw)) return []
  const out: DeployBracket[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.symbol !== 'string' || typeof r.exchange !== 'string') continue
    if (r.action !== 'BUY' && r.action !== 'SELL') continue
    if (r.stage !== 'watch' && r.stage !== 'armed' && r.stage !== 'done') continue
    const quantity = Number(r.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    const product =
      r.product === 'MIS' || r.product === 'NRML' || r.product === 'CNC' ? r.product : 'MIS'
    const num = (value: unknown): number | null => {
      const n = Number(value)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : newBracketId(),
      symbol: r.symbol,
      exchange: r.exchange,
      action: r.action,
      quantity,
      product,
      entry: num(r.entry),
      target: num(r.target),
      stoploss: num(r.stoploss),
      entryOrderid: typeof r.entryOrderid === 'string' && r.entryOrderid ? r.entryOrderid : null,
      stage: r.stage,
      closeTarget: typeof r.closeTarget === 'string' && r.closeTarget ? r.closeTarget : null,
      closeStop: typeof r.closeStop === 'string' && r.closeStop ? r.closeStop : null,
      attempts: Number.isFinite(Number(r.attempts))
        ? Math.max(0, Math.floor(Number(r.attempts)))
        : 0,
      createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now(),
    })
  }
  return out
}
