import { describe, expect, it } from 'vitest'
import { protectedPrice, resolveOrderPricing, roundToTick, useOrderModeStore } from './orderMode'

describe('roundToTick', () => {
  it('snaps to the 0.05 tick', () => {
    expect(roundToTick(44.212)).toBe(44.2)
    expect(roundToTick(44.23)).toBe(44.25)
    expect(roundToTick(45.55)).toBe(45.55)
  })

  it('never returns a negative or non-finite price', () => {
    expect(roundToTick(-3)).toBe(0)
    expect(roundToTick(Number.NaN)).toBe(0)
  })
})

describe('protectedPrice', () => {
  it('buys above the base and sells below it', () => {
    expect(protectedPrice(100, 'BUY', 3)).toBe(103)
    expect(protectedPrice(100, 'SELL', 3)).toBe(97)
  })

  it('is tick-rounded, matching the exchange grid', () => {
    // 44.2 + 3% = 45.526 → 45.55, the same figure the backend slab printed.
    expect(protectedPrice(44.2, 'BUY', 3)).toBe(45.55)
    expect(protectedPrice(44.2, 'SELL', 3)).toBe(42.85)
  })

  it('clamps absurd percents', () => {
    expect(protectedPrice(100, 'BUY', 500)).toBe(200)
    expect(protectedPrice(100, 'BUY', Number.NaN)).toBe(100)
  })
})

describe('resolveOrderPricing', () => {
  const base = { action: 'BUY' as const, mppPercent: 3 }

  it('market sends a plain market order', () => {
    const r = resolveOrderPricing({ ...base, mode: 'market', ltp: 44.2, entry: 40 })
    expect(r.pricetype).toBe('MARKET')
    expect(r.price).toBeUndefined()
  })

  it('limit rests at the entry level when one is set', () => {
    const r = resolveOrderPricing({ ...base, mode: 'limit', ltp: 44.2, entry: 40 })
    expect(r.pricetype).toBe('LIMIT')
    expect(r.price).toBe(40)
  })

  it('limit without an entry rides the live price', () => {
    const r = resolveOrderPricing({ ...base, mode: 'limit', ltp: 44.23 })
    expect(r.pricetype).toBe('LIMIT')
    expect(r.price).toBe(44.25)
  })

  it('mpp buffers the live price by the chosen percent', () => {
    const r = resolveOrderPricing({ ...base, mode: 'mpp', ltp: 44.2, entry: 40 })
    expect(r.pricetype).toBe('LIMIT')
    expect(r.price).toBe(45.55)
  })

  it('mpp on a SELL buffers below', () => {
    const r = resolveOrderPricing({ action: 'SELL', mode: 'mpp', mppPercent: 2, ltp: 100 })
    expect(r.price).toBe(98)
  })

  it('live is a plain limit at the shown price', () => {
    const r = resolveOrderPricing({ ...base, mode: 'live', ltp: 44.2, entry: 40 })
    expect(r.pricetype).toBe('LIMIT')
    expect(r.price).toBe(44.2)
  })

  it('falls back to market when no live price exists for a priced mode', () => {
    for (const mode of ['mpp', 'live', 'limit'] as const) {
      const r = resolveOrderPricing({ ...base, mode })
      expect(r.pricetype).toBe('MARKET')
      expect(r.note).toContain('no ')
    }
  })

  it('ignores a dead entry (zero / NaN) in limit mode', () => {
    const r = resolveOrderPricing({ ...base, mode: 'limit', ltp: 50, entry: 0 })
    expect(r.price).toBe(50)
  })
})

describe('useOrderModeStore', () => {
  it('defaults to limit mode with no MPP buffer — the limit rests at the live price', () => {
    const s = useOrderModeStore.getState()
    expect(s.mode).toBe('limit')
    expect(s.mppPercent).toBe(0)
  })

  it('clamps the percent on write', () => {
    useOrderModeStore.getState().setMppPercent(250)
    expect(useOrderModeStore.getState().mppPercent).toBe(100)
    useOrderModeStore.getState().setMppPercent(-5)
    expect(useOrderModeStore.getState().mppPercent).toBe(0)
    useOrderModeStore.getState().setMppPercent(3)
  })
})
