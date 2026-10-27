import { describe, expect, it } from 'vitest'
import type { DeployRow } from '@/lib/trading/deployPlan'
import type { ScheduledOrder } from '@/types/hedging'
import { entryMet, ladderFireOrders, planCrosses, planFireOrders, planForLadderBatch, swapFireOrders } from './tradingFire'

/**
 * What a due batch places, pinned without a DOM: the ladder's enabled rows
 * with their own lots, the plan's strike scope, the exit-all sweep, the
 * swap's leave-and-enter orders, and the entry-met arithmetic the level
 * deploy arms on.
 */

const row = (parts: Partial<DeployRow>): DeployRow => ({
  symbol: parts.symbol ?? 'NIFTY27OCT2624500CE',
  exchange: 'NFO',
  kind: parts.kind ?? 'option',
  strike: parts.strike ?? 24500,
  optionType: parts.optionType ?? 'CE',
  lotSize: parts.lotSize ?? 65,
  enabled: parts.enabled ?? true,
  lots: parts.lots ?? 0,
  weight: parts.weight ?? 0,
  entry: parts.entry ?? null,
  target: parts.target ?? null,
  stoploss: parts.stoploss ?? null,
})

const ladder = {
  ce: [
    row({ symbol: 'NIFTY27OCT2624500CE', strike: 24500, lots: 2 }),
    row({ symbol: 'NIFTY27OCT2624600CE', strike: 24600, lots: 1 }),
    row({ symbol: 'NIFTY27OCT2624700CE', strike: 24700, enabled: false }),
  ],
  pe: [row({ symbol: 'NIFTY27OCT2624500PE', strike: 24500, optionType: 'PE' as const, lots: 1 })],
}

const entry = (action: ScheduledOrder['action']): ScheduledOrder =>
  ({
    id: 'x',
    action,
    trigger: { kind: 'time', at: '09:20:00', repeat: 'once' },
    status: 'pending',
    createdAt: 0,
    modeAtCreation: 'fno',
  }) as ScheduledOrder

const plan = (parts: Partial<Parameters<typeof ladderFireOrders>[2]>): Parameters<typeof ladderFireOrders>[2] =>
  ({
    side: 'CE',
    strikes: [],
    optionAction: 'BUY',
    ...parts,
  }) as Parameters<typeof ladderFireOrders>[2]

describe('ladderFireOrders', () => {
  it('buys every enabled row of the plan side with their own lots', () => {
    const orders = ladderFireOrders(ladder, entry('deployA'), plan({ side: 'CE', optionAction: 'BUY' }))
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624500CE', exchange: 'NFO', action: 'BUY', quantity: 2 * 65 },
      { symbol: 'NIFTY27OCT2624600CE', exchange: 'NFO', action: 'BUY', quantity: 1 * 65 },
    ])
  })

  it('sells the named strikes only, and honors rows disabled since arming', () => {
    const orders = ladderFireOrders(
      ladder,
      entry('closeA'),
      plan({ side: 'CE', optionAction: 'SELL', strikes: [24500, 24700] })
    )
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624500CE', exchange: 'NFO', action: 'SELL', quantity: 2 * 65 },
    ])
  })

  it('sells both sides on exit-all, disabled rows skipped', () => {
    const orders = ladderFireOrders(ladder, entry('exitAll'), plan({}))
    expect(orders.map((order) => order.symbol)).toEqual([
      'NIFTY27OCT2624500CE',
      'NIFTY27OCT2624600CE',
      'NIFTY27OCT2624500PE',
    ])
    expect(orders.every((order) => order.action === 'SELL')).toBe(true)
  })

  it('places nothing without a ladder', () => {
    expect(ladderFireOrders(undefined, entry('deployA'), plan({}))).toEqual([])
  })

  it('sizes weight rows from the funds when the plan carries sizing', () => {
    const weighted = {
      ce: [row({ symbol: 'NIFTY27OCT2624500CE', strike: 24500, weight: 100 })],
      pe: [],
    }
    const sizing = { capital: 195000, ltpOf: () => 150 }
    const orders = ladderFireOrders(weighted, entry('deployA'), {
      ...plan({ side: 'CE', optionAction: 'BUY' }),
    })
    expect(orders).toEqual([])
    // the same ladder through the swap path, which carries sizing
    expect(swapFireOrders(weighted, 'PE', sizing)).toEqual([
      { symbol: 'NIFTY27OCT2624500CE', exchange: 'NFO', action: 'BUY', quantity: 20 * 65 },
    ])
  })
})

describe('swapFireOrders', () => {
  it('sells the side being left first, then buys the opposite side', () => {
    const orders = swapFireOrders(ladder, 'CE')
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624500CE', exchange: 'NFO', action: 'SELL', quantity: 2 * 65 },
      { symbol: 'NIFTY27OCT2624600CE', exchange: 'NFO', action: 'SELL', quantity: 1 * 65 },
      { symbol: 'NIFTY27OCT2624500PE', exchange: 'NFO', action: 'BUY', quantity: 1 * 65 },
    ])
  })

  it('reverses the order of operations when leaving the PE side', () => {
    const orders = swapFireOrders(ladder, 'PE')
    expect(orders.map((order) => order.action)).toEqual(['SELL', 'BUY', 'BUY'])
    expect(orders[0].symbol).toBe('NIFTY27OCT2624500PE')
  })

  it('runs the weight shares through the sizing both ways', () => {
    const sizing = { capital: 130000, ltpOf: (r: DeployRow) => (r.optionType === 'CE' ? 100 : 50) }
    const even = {
      ce: [row({ symbol: 'NIFTY27OCT2624500CE', strike: 24500, weight: 50, lots: 0 })],
      pe: [row({ symbol: 'NIFTY27OCT2624500PE', strike: 24500, optionType: 'PE' as const, weight: 50, lots: 0 })],
    }
    // CE share: 65000 / (100x65) = 10 lots; PE share: 65000 / (50x65) = 20 lots
    const orders = swapFireOrders(even, 'CE', sizing)
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624500CE', exchange: 'NFO', action: 'SELL', quantity: 10 * 65 },
      { symbol: 'NIFTY27OCT2624500PE', exchange: 'NFO', action: 'BUY', quantity: 20 * 65 },
    ])
  })

  it('places nothing without a ladder', () => {
    expect(swapFireOrders(undefined, 'CE')).toEqual([])
  })
})

describe('planForLadderBatch', () => {
  it('reads the verb from the action: deploy buys, close sells', () => {
    expect(
      planForLadderBatch({ action: 'deployB', side: 'PE', spot: null, enabledStrikes: [100] })
        .optionAction
    ).toBe('BUY')
    expect(
      planForLadderBatch({ action: 'closeA', side: 'CE', spot: null, enabledStrikes: [] })
        .optionAction
    ).toBe('SELL')
  })
})

describe('planCrosses', () => {
  it('keeps profit and stop on opposite sides of the entry', () => {
    const long = planCrosses({ side: 'CE', optionAction: 'BUY' })
    expect(long).toEqual({ target: 'above', stop: 'below' })
    const shortPut = planCrosses({ side: 'PE', optionAction: 'SELL' })
    // A sold put profits when the index rises — the same crossings as a
    // long call, which is what makes them a pair.
    expect(shortPut).toEqual({ target: 'above', stop: 'below' })
  })
})

describe('entryMet', () => {
  it('places now on a blank entry', () => {
    expect(entryMet(null, { target: 'above' }, 24000)).toBe(true)
    expect(entryMet(undefined, { target: 'above' }, undefined)).toBe(true)
  })

  it('waits while the spot has not crossed, fires once it has', () => {
    expect(entryMet(24500, { target: 'above' }, 24499)).toBe(false)
    expect(entryMet(24500, { target: 'above' }, 24500)).toBe(true)
    expect(entryMet(24500, { target: 'below' }, 24501)).toBe(false)
    expect(entryMet(24500, { target: 'below' }, 24499)).toBe(true)
  })

  it('waits without a spot quote rather than firing blind', () => {
    expect(entryMet(24500, { target: 'above' }, undefined)).toBe(false)
  })
})

describe('planFireOrders', () => {
  it('resolves plan strikes from the ladder rows, honoring per-row lots', () => {
    const orders = planFireOrders(ladder, 1, plan({ side: 'CE', optionAction: 'BUY', strikes: [24600] }), [])
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624600CE', exchange: 'NFO', action: 'BUY', quantity: 65 },
    ])
  })

  it('fills strikes the ladder dropped from the chain fallback rows', () => {
    const fallback = [row({ symbol: 'NIFTY27OCT2624800CE', strike: 24800 })]
    const orders = planFireOrders(
      ladder,
      2,
      plan({ side: 'CE', optionAction: 'BUY', strikes: [24800] }),
      fallback
    )
    expect(orders).toEqual([
      { symbol: 'NIFTY27OCT2624800CE', exchange: 'NFO', action: 'BUY', quantity: 2 * 65 },
    ])
  })

  it('skips strikes neither the ladder nor the chain lists', () => {
    const orders = planFireOrders(ladder, 1, plan({ strikes: [99999] }), [])
    expect(orders).toEqual([])
  })
})
