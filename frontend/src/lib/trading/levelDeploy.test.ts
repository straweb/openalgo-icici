import { describe, expect, it } from 'vitest'
import { resolveLevelPick } from './levelDeploy'
import type { OptionChainResponse } from '@/types/option-chain'

const chain = {
  atm_strike: 24500,
  underlying_ltp: 24487,
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
  ],
} as unknown as OptionChainResponse

describe('resolveLevelPick', () => {
  it('resolves the ATM pick against the chain into ladder rows', () => {
    const resolved = resolveLevelPick({
      chain,
      interval: 100,
      plan: { side: 'CE', optionAction: 'BUY', pick: { mode: 'atm' } },
      existing: [],
      optionsExchange: 'NFO',
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.planned).toEqual([24500])
    expect(resolved!.picked.map((r) => r.symbol)).toEqual(['NIFTY28OCT2624500CE'])
    expect(resolved!.skipped).toEqual([])
  })

  it('resolves offsets and flags strikes the chain does not list', () => {
    const resolved = resolveLevelPick({
      chain,
      interval: 100,
      plan: { side: 'PE', optionAction: 'BUY', pick: { mode: 'above', count: 2 } },
      existing: [],
      optionsExchange: 'NFO',
    })
    expect(resolved!.planned).toEqual([24600, 24700])
    expect(resolved!.picked).toEqual([])
    expect(resolved!.skipped).toEqual([24600, 24700])
  })

  it('returns null without a chain', () => {
    expect(
      resolveLevelPick({
        chain: null,
        interval: 100,
        plan: { side: 'CE', optionAction: 'BUY', pick: { mode: 'atm' } },
        existing: [],
        optionsExchange: 'NFO',
      })
    ).toBeNull()
  })
})
