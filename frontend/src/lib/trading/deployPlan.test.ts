import { describe, expect, it } from 'vitest'
import {
  bookKey,
  chainLtp,
  defaultDeployState,
  firingRows,
  hydrateDeployState,
  rowsFromStrikes,
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
  it('fires enabled rows only, batch lots as the default', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24400, 24500]).rows
    rows[1].enabled = false
    const plan = firingRows(rows, 2)
    expect(plan).toEqual([{ row: rows[0], qty: 150 }])
  })

  it('a row with its own lots overrides the batch', () => {
    const rows = rowsFromStrikes(chain, 'CE', [24500]).rows
    rows[0].lots = 3
    expect(firingRows(rows, 1)[0].qty).toBe(225)
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
