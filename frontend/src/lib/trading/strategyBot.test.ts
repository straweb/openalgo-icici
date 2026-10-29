import { describe, expect, it } from 'vitest'
import {
  entryEdge,
  evalConditions,
  exitReason,
  istSecondsNow,
  loadBots,
  parseClockToSec,
  type StrategyBot,
  type StrategyCondition,
  type StrategyTickContext,
  secToClock,
} from './strategyBot'

const ctx = (over: Partial<StrategyTickContext> = {}): StrategyTickContext => ({
  indexLtp: 73800,
  legLtp: new Map([['leg-ce', 400]]),
  istSec: 11 * 3600 + 15 * 60, // 11:15:00
  ...over,
})

const cond = (over: Partial<StrategyCondition> = {}): StrategyCondition => ({
  id: 'c1',
  join: 'and',
  field: 'index',
  op: '<',
  value: 73800,
  ...over,
})

describe('parseClockToSec / secToClock', () => {
  it('reads HH:MM:SS and HH:MM to seconds from midnight', () => {
    expect(parseClockToSec('11:00:00')).toBe(11 * 3600)
    expect(parseClockToSec('9:15')).toBe(9 * 3600 + 15 * 60)
    expect(parseClockToSec('23:59:59')).toBe(23 * 3600 + 59 * 60 + 59)
  })

  it('refuses anything that is not a clock', () => {
    expect(parseClockToSec('11')).toBeNull()
    expect(parseClockToSec('25:00:00')).toBeNull()
    expect(parseClockToSec('abc')).toBeNull()
    expect(parseClockToSec('11:60')).toBeNull()
  })

  it('round-trips through the padded form', () => {
    expect(secToClock(parseClockToSec('9:05:07')!)).toBe('09:05:07')
  })
})

describe('evalConditions', () => {
  it('is false for an empty list: nothing to say is never true', () => {
    expect(evalConditions([], ctx())).toBe(false)
  })

  it('reads a plain index comparison', () => {
    expect(evalConditions([cond({ op: '<', value: 73900 })], ctx())).toBe(true)
    expect(evalConditions([cond({ op: '>', value: 73900 })], ctx())).toBe(false)
    expect(evalConditions([cond({ op: '>=', value: 73800 })], ctx())).toBe(true)
  })

  it('reads a strike comparison against the named leg only', () => {
    expect(
      evalConditions([cond({ field: 'strike', legId: 'leg-ce', op: '<', value: 400 })], ctx())
    ).toBe(false)
    expect(
      evalConditions([cond({ field: 'strike', legId: 'leg-ce', op: '<', value: 401 })], ctx())
    ).toBe(true)
    // An unnamed leg, or a leg that has not ticked, is not true.
    expect(evalConditions([cond({ field: 'strike', op: '<', value: 999 })], ctx())).toBe(false)
    expect(
      evalConditions([cond({ field: 'strike', legId: 'nope', op: '<', value: 999 })], ctx())
    ).toBe(false)
  })

  it('reads time to the second, between inclusive', () => {
    expect(evalConditions([cond({ field: 'time', op: '>', value: 11 * 3600 })], ctx())).toBe(true)
    expect(
      evalConditions(
        [cond({ field: 'time', op: 'between', value: 11 * 3600, value2: 11 * 3600 + 1800 })],
        ctx()
      )
    ).toBe(true)
    expect(
      evalConditions(
        [cond({ field: 'time', op: 'between', value: 11 * 3600 + 1800, value2: 12 * 3600 })],
        ctx()
      )
    ).toBe(false)
  })

  it("joins left to right with each row's own joiner", () => {
    // index < 73800 is false here; AND would kill the row, OR would not.
    expect(
      evalConditions(
        [cond({ op: '<', value: 70000 }), cond({ join: 'or', field: 'time', op: '>', value: 0 })],
        ctx()
      )
    ).toBe(true)
    expect(
      evalConditions(
        [cond({ op: '<', value: 70000 }), cond({ join: 'and', field: 'time', op: '>', value: 0 })],
        ctx()
      )
    ).toBe(false)
    // ((a OR b) AND c) — the user's exit example's shape.
    expect(
      evalConditions(
        [
          cond({ op: '>', value: 80000 }),
          cond({ join: 'or', field: 'time', op: '>', value: 0 }),
          cond({ join: 'and', field: 'strike', legId: 'leg-ce', op: '<', value: 500 }),
        ],
        ctx()
      )
    ).toBe(true)
  })

  it('treats a missing index quote as an unmet condition', () => {
    expect(evalConditions([cond({ op: '<', value: 99999 })], ctx({ indexLtp: undefined }))).toBe(
      false
    )
  })
})

describe('entryEdge', () => {
  const bot = {
    entry: [cond({ op: '<', value: 73900 })],
  } as StrategyBot

  it('fires on the crossing, not on the level', () => {
    expect(entryEdge(bot, ctx(), false)).toBe(true)
    expect(entryEdge(bot, ctx(), true)).toBe(false)
  })
})

describe('exitReason', () => {
  const base: StrategyBot = {
    id: 'b',
    name: 'n',
    underlying: { symbol: 'SENSEX', exchange: 'NSE_INDEX' },
    legs: [{ id: 'leg-ce', symbol: 'X', exchange: 'BFO', lots: 75 }],
    side: 'BUY',
    product: 'MIS',
    pricetype: 'MARKET',
    entry: [cond()],
    exit: [],
    status: 'open',
  }

  it('answers the exit conditions first', () => {
    expect(exitReason({ ...base, exit: [cond({ field: 'time', op: '>', value: 0 })] }, ctx())).toBe(
      'conditions'
    )
  })

  it('reads target and stop off the entry reference, on the side ridden', () => {
    const bot = { ...base, legEntryRef: { 'leg-ce': 380 }, target: 15, stoploss: 10 }
    expect(exitReason(bot, ctx())).toBe('target') // 400 - 380 = +20
    expect(exitReason(bot, ctx({ legLtp: new Map([['leg-ce', 369]]) }))).toBe('stoploss') // -11
    const short = { ...bot, side: 'SELL' as const }
    expect(exitReason(short, ctx({ legLtp: new Map([['leg-ce', 360]]) }))).toBe('target') // +20 short
  })

  it('answers null while nothing is met and no levels are set', () => {
    expect(exitReason(base, ctx())).toBeNull()
    expect(exitReason({ ...base, target: 100 }, ctx())).toBeNull()
  })
})

describe('istSecondsNow', () => {
  it('maps a UTC instant to its IST clock reading', () => {
    // 2026-10-29T05:30:00Z is 11:00:00 IST.
    expect(istSecondsNow(Date.UTC(2026, 9, 29, 5, 30, 0))).toBe(11 * 3600)
  })
})

describe('loadBots', () => {
  it('parks running bots back at idle: the ticks stopped with the page', () => {
    globalThis.localStorage.setItem(
      'oa-trading-strategy-bots',
      JSON.stringify([
        {
          id: 'a',
          name: 'A',
          underlying: { symbol: 'S', exchange: 'NSE_INDEX' },
          legs: [],
          entry: [],
          exit: [],
          status: 'watching',
        },
        {
          id: 'b',
          name: 'B',
          underlying: { symbol: 'S', exchange: 'NSE_INDEX' },
          legs: [],
          entry: [],
          exit: [],
          status: 'completed',
        },
      ])
    )
    const bots = loadBots()
    expect(bots.map((b) => b.status)).toEqual(['idle', 'completed'])
    globalThis.localStorage.removeItem('oa-trading-strategy-bots')
  })

  it('answers empty on malformed storage', () => {
    globalThis.localStorage.setItem('oa-trading-strategy-bots', '{not json')
    expect(loadBots()).toEqual([])
    globalThis.localStorage.removeItem('oa-trading-strategy-bots')
  })
})
