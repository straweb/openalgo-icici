import { describe, expect, it } from 'vitest'
import type { Order } from '@/types/trading'
import {
  activeBrackets,
  advanceBracket,
  closingAction,
  type DeployBracket,
  hydrateBrackets,
  planBracket,
  upsertBracket,
} from './bracket'

/**
 * The bracket engine's rules, pinned without a DOM: what arms a watch, what
 * a fill places, what a flat position pulls, and the two mistakes the
 * engine must never make — placing closes on a blind read, and leaving a
 * sibling close working after the trade is over.
 */

const bracket = (parts: Partial<DeployBracket> = {}): DeployBracket => ({
  id: parts.id ?? 'brk-1',
  symbol: parts.symbol ?? 'NIFTY27OCT2624500CE',
  exchange: parts.exchange ?? 'NFO',
  action: parts.action ?? 'BUY',
  quantity: parts.quantity ?? 65,
  product: parts.product ?? 'NRML',
  entry: parts.entry ?? 40,
  target: parts.target ?? 80,
  stoploss: parts.stoploss ?? 20,
  entryOrderid: parts.entryOrderid ?? 'ord-1',
  stage: parts.stage ?? 'watch',
  closeTarget: parts.closeTarget ?? null,
  closeStop: parts.closeStop ?? null,
  attempts: parts.attempts ?? 0,
  createdAt: parts.createdAt ?? 1_000,
})

const order = (parts: Partial<Order> = {}): Order => ({
  symbol: parts.symbol ?? 'NIFTY27OCT2624500CE',
  exchange: parts.exchange ?? 'NFO',
  action: parts.action ?? 'BUY',
  quantity: parts.quantity ?? 65,
  price: parts.price ?? 40,
  trigger_price: parts.trigger_price ?? 0,
  pricetype: parts.pricetype ?? 'LIMIT',
  product: parts.product ?? 'NRML',
  orderid: parts.orderid ?? 'ord-1',
  order_status: parts.order_status ?? 'open',
  timestamp: parts.timestamp ?? '2026-10-28 09:15:00',
})

describe('planBracket', () => {
  it('arms nothing when the row carries neither target nor stop', () => {
    expect(
      planBracket({
        symbol: 'X',
        exchange: 'NFO',
        action: 'BUY',
        quantity: 65,
        product: 'NRML',
        entry: 40,
        target: null,
        stoploss: null,
      })
    ).toBeNull()
  })

  it('arms with a target alone, the entry recorded even for a market print', () => {
    const planned = planBracket({
      symbol: 'X',
      exchange: 'NFO',
      action: 'BUY',
      quantity: 65,
      product: 'MIS',
      entry: null,
      target: 80,
      stoploss: null,
    })
    expect(planned).not.toBeNull()
    expect(planned?.stage).toBe('watch')
    expect(planned?.entryOrderid).toBeNull()
    expect(planned?.product).toBe('MIS')
  })
})

describe('closingAction', () => {
  it('leaves a long with a sell and a short with a buy', () => {
    expect(closingAction('BUY')).toBe('SELL')
    expect(closingAction('SELL')).toBe('BUY')
  })
})

describe('advanceBracket — watch', () => {
  it('waits while the entry is still working', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'open' })],
      positionQty: undefined,
      positionsKnown: true,
    })
    expect(decision.place).toHaveLength(0)
    expect(decision.bracket.stage).toBe('watch')
  })

  it('waits while the entry order has not surfaced in the book', () => {
    const decision = advanceBracket(bracket(), { orders: [], positionsKnown: true })
    expect(decision.place).toHaveLength(0)
    expect(decision.bracket.stage).toBe('watch')
  })

  it('places the target as a LIMIT and the stop as an SL-M on the closing side when the entry fills', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'complete' })],
      positionQty: 65,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('armed')
    expect(decision.place).toHaveLength(2)
    const [target, stop] = decision.place
    expect(target).toMatchObject({
      key: 'closeTarget',
      action: 'SELL',
      pricetype: 'LIMIT',
      quantity: 65,
      price: 80,
    })
    expect(stop).toMatchObject({
      key: 'closeStop',
      action: 'SELL',
      pricetype: 'SL-M',
      quantity: 65,
      trigger_price: 20,
    })
  })

  it('sizes the closes to the position the broker actually shows', () => {
    const decision = advanceBracket(bracket({ quantity: 130 }), {
      orders: [order({ order_status: 'complete' })],
      positionQty: 65,
      positionsKnown: true,
    })
    expect(decision.place.every((plan) => plan.quantity === 65)).toBe(true)
  })

  it('waits for a position truth instead of guessing one when the read failed', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'complete' })],
      positionQty: undefined,
      positionsKnown: false,
    })
    expect(decision.place).toHaveLength(0)
    expect(decision.bracket.stage).toBe('watch')
  })

  it('ends the watch when the entry dies with nothing held', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'rejected' })],
      positionQty: undefined,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('done')
    expect(decision.place).toHaveLength(0)
  })

  it('still attaches the closes when a cancelled entry left a partial fill', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'cancelled' })],
      positionQty: 30,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('armed')
    expect(decision.place.every((plan) => plan.quantity === 30)).toBe(true)
  })

  it('ends the watch when the trade already came and went — a closing-side order is in the book', () => {
    const decision = advanceBracket(bracket(), {
      orders: [
        order({ order_status: 'complete' }),
        order({ orderid: 'ord-9', action: 'SELL', order_status: 'complete' }),
      ],
      positionQty: 0,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('done')
    expect(decision.place).toHaveLength(0)
  })

  it('treats a fill the position book has not caught up with as held — the closes go out', () => {
    const decision = advanceBracket(bracket(), {
      orders: [order({ order_status: 'complete' })],
      positionQty: 0,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('armed')
    expect(decision.place).toHaveLength(2)
  })
})

describe('advanceBracket — armed', () => {
  const armed = bracket({ stage: 'armed', closeTarget: 'ord-t', closeStop: 'ord-s' })

  it('holds while the position lives', () => {
    const decision = advanceBracket(armed, {
      orders: [
        order({ orderid: 'ord-t', action: 'SELL', pricetype: 'LIMIT', price: 80 }),
        order({ orderid: 'ord-s', action: 'SELL', pricetype: 'SL-M', trigger_price: 20 }),
      ],
      positionQty: 65,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('armed')
    expect(decision.cancel).toHaveLength(0)
  })

  it('pulls the sibling that is still working when the position goes flat', () => {
    const decision = advanceBracket(armed, {
      orders: [
        order({ orderid: 'ord-t', action: 'SELL', order_status: 'complete' }),
        order({ orderid: 'ord-s', action: 'SELL', order_status: 'trigger pending' }),
      ],
      positionQty: 0,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('done')
    expect(decision.cancel).toEqual(['ord-s'])
  })

  it('never pulls closes on a blind read — a failed positions poll changes nothing', () => {
    const decision = advanceBracket(armed, {
      orders: [order({ orderid: 'ord-s', action: 'SELL', order_status: 'open' })],
      positionQty: undefined,
      positionsKnown: false,
    })
    expect(decision.bracket.stage).toBe('armed')
    expect(decision.cancel).toHaveLength(0)
  })

  it('ends when the trader pulled both closes by hand while the position lives', () => {
    const decision = advanceBracket(armed, {
      orders: [],
      positionQty: 65,
      positionsKnown: true,
    })
    expect(decision.bracket.stage).toBe('done')
  })
})

describe('book helpers', () => {
  it('activeBrackets drops only the finished ones', () => {
    const list = [
      bracket({ id: 'a', stage: 'watch' }),
      bracket({ id: 'b', stage: 'armed' }),
      bracket({ id: 'c', stage: 'done' }),
    ]
    expect(activeBrackets(list).map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('upsertBracket replaces by id, keeping order', () => {
    const list = upsertBracket(
      [bracket({ id: 'a' }), bracket({ id: 'b' })],
      bracket({ id: 'a', stage: 'armed' })
    )
    expect(list.map((b) => `${b.id}:${b.stage}`)).toEqual(['b:watch', 'a:armed'])
  })
})

describe('hydrateBrackets', () => {
  it('keeps well-formed brackets and drops junk shapes', () => {
    const list = hydrateBrackets([
      {
        id: 'ok',
        symbol: 'X',
        exchange: 'NFO',
        action: 'BUY',
        quantity: 65,
        product: 'NRML',
        entry: 40,
        target: 80,
        stoploss: 20,
        entryOrderid: 'ord-1',
        stage: 'watch',
        closeTarget: null,
        closeStop: null,
        createdAt: 5,
      },
      { symbol: 'no-stage' },
      { symbol: 'X', exchange: 'NFO', action: 'SIDEWAYS', stage: 'watch', quantity: 1 },
      { symbol: 'X', exchange: 'NFO', action: 'BUY', stage: 'watch', quantity: -5 },
      'not-an-object',
      null,
    ])
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('ok')
    expect(list[0].attempts).toBe(0)
  })

  it('reads a non-array as an empty book and repairs missing ids', () => {
    expect(hydrateBrackets(undefined)).toEqual([])
    expect(hydrateBrackets('nope')).toEqual([])
    const repaired = hydrateBrackets([
      { symbol: 'X', exchange: 'NFO', action: 'BUY', quantity: 1, stage: 'watch' },
    ])
    expect(repaired[0].id).toMatch(/^brk-/)
  })
})
