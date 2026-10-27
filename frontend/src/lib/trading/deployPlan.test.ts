import { describe, expect, it } from 'vitest'
import {
  bookKey,
  chainLtp,
  constructedOptionSymbol,
  constructedRows,
  defaultDeployState,
  equalSplitSide,
  ensureSideWeights,
  firingRows,
  hydrateDeployState,
  normalizeSideWeights,
  reconcileConstructed,
  rowsFromStrikes,
  rowQty,
  sideOfRow,
  slideSideWeight,
  stockRowFromSearch,
  autoLots,
} from './deployPlan'
import type { OptionChainResponse } from '@/types/option-chain'

const chain = {
  atm_strike: 24500,
  chain: [
    {
      strike: 24400,
      ce: { symbol: 'NIFTY28OCT2624400CE', ltp: 210, lotsize: 75 },
      pe: { symbol: 'NIFTY28OCT2624400PE', ltp: 55, lotsize: 75 },
    },
    {
      strike: 24500,
      ce: { symbol: 'NIFTY28OCT2624500CE', ltp: 130, lotsize: 75 },
      pe: { symbol: 'NIFTY28OCT2624500PE', ltp: 90, lotsize: 75 },
    },
    {
      strike: 24550,
      ce: null,
      pe: { symbol: 'NIFTY28OCT2624550PE', ltp: 110, lotsize: 75 },
    },
  ],
} as unknown as OptionChainResponse

describe('rowsFromStrikes', () => {
  it('resolves strikes through the chain snapshot', () => {
    const { rows, skipped } = rowsFromStrikes(chain, 'CE', [24400, 24500])
    expect(skipped).toEqual([])
    expect(rows.map((r) => r.symbol)).toEqual(['NIFTY28OCT2624400CE', 'NIFTY28OCT2624500CE'])
    expect(rows.every((r) => r.lotSize === 75 && r.enabled)).toBe(true)
  })

  it('skips strikes the snapshot does not list instead of inventing symbols', () => {
    const { rows, skipped } = rowsFromStrikes(chain, 'CE', [24400, 24700])
    expect(skipped).toEqual([24700])
    expect(rows).toHaveLength(1)
  })

  it('skips a side with no listed leg', () => {
    const { rows, skipped } = rowsFromStrikes(chain, 'CE', [24550])
    expect(skipped).toEqual([24550])
    expect(rows).toHaveLength(0)
  })

  it('keeps prior rows and their enabled choices across refreshes', () => {
    const first = rowsFromStrikes(chain, 'PE', [24400, 24500]).rows
    first[0].enabled = false
    const again = rowsFromStrikes(chain, 'PE', [24500], first)
    expect(again.rows.map((r) => r.symbol)).toContain('NIFTY28OCT2624400PE')
    const kept = again.rows.find((r) => r.symbol === 'NIFTY28OCT2624400PE')
    expect(kept?.enabled).toBe(false)
  })
})

describe('chainLtp', () => {
  it('reads the leg the symbol belongs to', () => {
    expect(chainLtp(chain, 'NIFTY28OCT2624500PE')).toBe(90)
    expect(chainLtp(chain, 'NIFTY28OCT2624500CE')).toBe(130)
    expect(chainLtp(chain, 'NIFTY28OCT2624999CE')).toBeUndefined()
    expect(chainLtp(null, 'NIFTY28OCT2624500CE')).toBeUndefined()
  })
})

describe('firingRows', () => {
  it('fires enabled rows with manual lots and drops the rest', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24400, 24500]).rows
    rows[0].lots = 2
    rows[1].enabled = false
    expect(firingRows(rows)).toEqual([{ row: rows[0], qty: 150 }])
  })

  it('sizes weight rows from the funds share at the live price', () => {
    const rows = equalSplitSide(
      normalizeSideWeights(rowsFromStrikes(chain, 'CE', [24400, 24500]).rows),
      'CE'
    )
    // 50% of 200000 against 210 x 75 per lot: floor(100000 / 15750) = 6 lots
    expect(firingRows(rows, { capital: 200000, ltpOf: () => 210 })[0].qty).toBe(450)
  })

  it('a row whose weight cannot carry one lot drops out', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24400]).rows
    rows[0].weight = 10
    // 10% of 5000 = 500 against 15750 per lot: zero lots, no order
    expect(firingRows(rows, { capital: 5000, ltpOf: () => 210 })).toEqual([])
  })

  it('manual lots win over the weight size', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24500]).rows
    rows[0].lots = 3
    rows[0].weight = 100
    expect(rowQty(rows[0], 130, 1000000)).toBe(225)
  })

  it('autoLots floors the weight share against the per-lot price', () => {
    const row = rowsFromStrikes(chain, 'CE', [24500]).rows[0]
    row.weight = 25
    // 25% of 31500 = 7875 against 130 x 75 = 9750: zero lots
    expect(autoLots(row, 130, 31500)).toBe(0)
    // 25% of 63000 = 15750 against 9750: one lot
    expect(autoLots(row, 130, 63000)).toBe(1)
  })
})

describe('persistence', () => {
  it('round-trips through hydrate without losing choices', () => {
    const state = defaultDeployState()
    state.product = 'NRML'
    state.lots = 4
    const key = bookKey('NFO', 'NIFTY')
    state.books[key] = {
      ce: rowsFromStrikes(chain, 'CE', [24500]).rows,
      pe: [],
    }
    state.books[key].ce[0].lots = 2
    const back = hydrateDeployState(JSON.parse(JSON.stringify(state)))
    expect(back.product).toBe('NRML')
    expect(back.lots).toBe(4)
    expect(back.books[key]?.ce[0]).toMatchObject({ symbol: 'NIFTY28OCT2624500CE', lots: 2 })
  })

  it('a partial snapshot hydrates to a whole state, not a half-formed panel', () => {
    const back = hydrateDeployState({
      product: 'CNC',
      books: { broken: null, ok: { pe: [{ symbol: 'X', strike: 100, optionType: 'PE' }] } },
    })
    expect(back.product).toBe('CNC')
    expect(back.pricetype).toBe('MARKET')
    expect(back.books['ok']?.pe[0]?.exchange).toBe('NFO')
    expect(back.books['broken']).toBeUndefined()
  })

  it('garbage reads as the default state', () => {
    expect(hydrateDeployState('nope')).toEqual(defaultDeployState())
    expect(hydrateDeployState(null)).toEqual(defaultDeployState())
  })
})

describe('the weight engine', () => {
  it('equalSplitSide divides a side to exactly 100, residue on the last row', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24400, 24500]).rows
    const split = equalSplitSide(rows, 'CE')
    const total = split.reduce((sum, r) => sum + r.weight, 0)
    expect(Math.round(total * 10) / 10).toBe(100)
    expect(split[0].weight).toBe(50)
  })

  it('normalizeSideWeights rescales each side independently', () => {
    const rows = [
      ...rowsFromStrikes(chain, 'CE', [24400]).rows.map((r) => ({ ...r, weight: 30 })),
      ...rowsFromStrikes(chain, 'PE', [24400]).rows.map((r) => ({ ...r, weight: 30 })),
    ]
    const fixed = normalizeSideWeights(rows)
    const sum = (side: 'CE' | 'PE') =>
      fixed.filter((r) => r.optionType === side).reduce((s, r) => s + r.weight, 0)
    expect(Math.round(sum('CE') * 10) / 10).toBe(100)
    expect(Math.round(sum('PE') * 10) / 10).toBe(100)
  })

  it('slideSideWeight keeps the side at 100 while one row moves', () => {
    const rows = equalSplitSide(rowsFromStrikes(chain, 'CE', [24400, 24500]).rows, 'CE')
    const slid = slideSideWeight(rows, rows[0].symbol, 80)
    expect(slid.find((r) => r.symbol === rows[0].symbol)?.weight).toBe(80)
    const total = slid.reduce((sum, r) => sum + r.weight, 0)
    expect(Math.round(total * 10) / 10).toBe(100)
  })

  it('sideOfRow reads stocks as EQ and options by their type', () => {
    const option = rowsFromStrikes(chain, 'PE', [24500]).rows[0]
    expect(sideOfRow(option)).toBe('PE')
    expect(sideOfRow(stockRowFromSearch({ symbol: 'TCS', exchange: 'NSE' }))).toBe('EQ')
  })

  it('ensureSideWeights gives weightless (pre-rework) sides their even split', () => {
    const state = defaultDeployState()
    const key = bookKey('NFO', 'NIFTY')
    state.books[key] = { ce: rowsFromStrikes(chain, 'CE', [24400, 24500]).rows, pe: [] }
    const fixed = ensureSideWeights(state)
    expect(fixed.books[key]?.ce.map((r) => r.weight)).toEqual([50, 50])
    expect(fixed.books[key]?.pe).toEqual([])
  })
})

describe('constructed symbols', () => {
  it('builds the OpenAlgo convention, dashes stripped from the expiry', () => {
    expect(constructedOptionSymbol('NIFTY', '09-NOV-26', 17350, 'CE')).toBe('NIFTY09NOV2617350CE')
    expect(constructedOptionSymbol('nifty', '09NOV26', 17350, 'PE')).toBe('NIFTY09NOV2617350PE')
  })

  it('constructedRows flags every row and keeps existing strikes', () => {
    const existing = rowsFromStrikes(chain, 'CE', [24500]).rows
    const rows = constructedRows('CE', [24500, 24550], {
      base: 'NIFTY',
      expiry: '28OCT26',
      exchange: 'NFO',
    }, existing)
    expect(rows.map((r) => r.strike)).toEqual([24500, 24550])
    expect(rows[0].constructed).toBeFalsy()
    expect(rows[1].constructed).toBe(true)
    expect(rows[1].symbol).toBe('NIFTY28OCT2624550CE')
    expect(rows[1].lotSize).toBe(75)
  })

  it('reconcileConstructed promotes rows to the chain\'s exact listed symbols', () => {
    const existing = constructedRows('CE', [24400, 24700], {
      base: 'NIFTY',
      expiry: '28OCT26',
      exchange: 'NFO',
    })
    const { rows, promoted } = reconcileConstructed(chain, existing, 'NFO')
    expect(promoted).toBe(1)
    const listed = rows.find((r) => r.strike === 24400)
    expect(listed?.symbol).toBe('NIFTY28OCT2624400CE')
    expect(listed?.constructed).toBe(false)
    expect(listed?.lotSize).toBe(75)
    // a strike the chain does not list stays constructed
    expect(rows.find((r) => r.strike === 24700)?.constructed).toBe(true)
  })
})

describe('stock rows', () => {
  it('stockRowFromSearch carries the lot size and name', () => {
    const row = stockRowFromSearch({ symbol: 'TCS', exchange: 'NSE', lotsize: 350, name: 'Tata Consultancy' })
    expect(row.kind).toBe('stock')
    expect(row.lotSize).toBe(350)
    expect(row.name).toBe('Tata Consultancy')
    expect(row.enabled).toBe(true)
  })

  it('a stock without a lot size reads as shares (lotSize 1)', () => {
    expect(stockRowFromSearch({ symbol: 'XYZ', exchange: 'NSE' }).lotSize).toBe(1)
  })

  it('the stock list lives on the book and survives hydrate', () => {
    const state = defaultDeployState()
    state.stocks = [stockRowFromSearch({ symbol: 'TCS', exchange: 'NSE', lotsize: 350 })]
    const back = hydrateDeployState(JSON.parse(JSON.stringify(state)))
    expect(back.stocks).toHaveLength(1)
    expect(back.stocks[0]).toMatchObject({ symbol: 'TCS', kind: 'stock', lotSize: 350 })
  })
})

describe('v2 books hydrate forward', () => {
  it('rows saved before the rework gain the option kind and zero weights', () => {
    const back = hydrateDeployState({
      books: { 'NFO:NIFTY': { ce: [{ symbol: 'NIFTY28OCT2624500CE', strike: 24500, optionType: 'CE', lotSize: 75, enabled: true, lots: 0 }], pe: [] } },
    })
    const row = back.books['NFO:NIFTY']?.ce[0]
    expect(row?.kind).toBe('option')
    expect(row?.weight).toBe(0)
    expect(row?.entry).toBeNull()
  })
})
