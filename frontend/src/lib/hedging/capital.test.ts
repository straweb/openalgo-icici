import { describe, expect, it } from 'vitest'
import { clampedBase, usableCapital } from './capital'

describe('clampedBase', () => {
  it('lets a fixed amount inside cash through untouched', () => {
    expect(clampedBase(75_000, 100_000)).toBe(75_000)
  })

  it('clamps a fixed amount larger than cash to cash', () => {
    expect(clampedBase(150_000, 100_000)).toBe(100_000)
  })

  it('treats a missing funds snapshot as zero cash', () => {
    expect(clampedBase(75_000, NaN)).toBe(0)
    expect(clampedBase(75_000, -1)).toBe(0)
  })

  it('floors negative allocations at zero', () => {
    expect(clampedBase(-5_000, 100_000)).toBe(0)
  })

  it("coerces the funds endpoint's string cash — a string used to clamp every basis to zero", () => {
    // The broker layer answers "availablecash": "123456.00" (2-dp strings);
    // Number.isFinite on a string is false, which read as no cash at all.
    expect(clampedBase(75_000, '123456.00' as unknown as number)).toBe(75_000)
    expect(clampedBase(200_000, '123456.00' as unknown as number)).toBe(123_456)
  })
})

describe('usableCapital — initial basis', () => {
  const base = { base: 75_000, cash: 100_000, deployedOnce: false }

  it('returns the allocation when nothing has happened yet', () => {
    expect(usableCapital('initial', { ...base, dayPnl: 0, realizedPnl: 0 })).toBe(75_000)
  })

  it('reduces by realized losses (brokerage and taxes ride on the net result)', () => {
    expect(usableCapital('initial', { ...base, dayPnl: -2_500, realizedPnl: -2_500 })).toBe(72_500)
  })

  it('never adds realized profit back', () => {
    expect(usableCapital('initial', { ...base, dayPnl: 9_000, realizedPnl: 9_000 })).toBe(75_000)
  })

  it('ignores floating unrealized profit but keeps floating losses out of the budget too', () => {
    // Unrealized marks are not spendable in either direction.
    expect(usableCapital('initial', { ...base, dayPnl: 4_000, realizedPnl: 0 })).toBe(75_000)
    expect(usableCapital('initial', { ...base, dayPnl: -1_000, realizedPnl: 0 })).toBe(75_000)
  })

  it('floors at zero after a big realized loss', () => {
    expect(usableCapital('initial', { ...base, dayPnl: -90_000, realizedPnl: -90_000 })).toBe(0)
  })
})

describe('usableCapital — withPnl basis', () => {
  const base = { base: 75_000, cash: 100_000, deployedOnce: false }

  it('adds the session P&L so profit can be traded at any time', () => {
    expect(usableCapital('withPnl', { ...base, dayPnl: 12_000, realizedPnl: 8_000 })).toBe(87_000)
  })

  it('also shrinks with losses, realized or floating', () => {
    expect(usableCapital('withPnl', { ...base, dayPnl: -3_000, realizedPnl: -1_000 })).toBe(72_000)
  })

  it('floors at zero', () => {
    expect(usableCapital('withPnl', { ...base, dayPnl: -200_000, realizedPnl: -200_000 })).toBe(0)
  })
})

describe('usableCapital — house basis', () => {
  const base = { base: 75_000, cash: 100_000 }

  it('spends the full allocation before the first deployment', () => {
    expect(
      usableCapital('house', { ...base, dayPnl: 0, realizedPnl: 0, deployedOnce: false })
    ).toBe(75_000)
  })

  it('after the first deployment only realized profit is tradable', () => {
    expect(
      usableCapital('house', { ...base, dayPnl: 9_000, realizedPnl: 6_500, deployedOnce: true })
    ).toBe(6_500)
  })

  it('a losing session cannot deploy again', () => {
    expect(
      usableCapital('house', { ...base, dayPnl: -4_000, realizedPnl: -4_000, deployedOnce: true })
    ).toBe(0)
  })

  it('unrealized profit alone does not arm the next deployment', () => {
    expect(
      usableCapital('house', { ...base, dayPnl: 11_000, realizedPnl: 0, deployedOnce: true })
    ).toBe(0)
  })

  it('respects the cash clamp on the first deployment', () => {
    expect(
      usableCapital('house', {
        base: 150_000,
        cash: 100_000,
        dayPnl: 0,
        realizedPnl: 0,
        deployedOnce: false,
      })
    ).toBe(100_000)
  })
})

describe('the available basis — the whole account, no allocation lock', () => {
  const base = { base: 75_000, cash: 100_000, deployedOnce: false }

  it('spends the entire available cash plus the session P&L', () => {
    expect(usableCapital('available', { ...base, dayPnl: 9_000, realizedPnl: 6_500 })).toBe(109_000)
  })

  it('ignores the allocated amount entirely — nothing is locked', () => {
    expect(
      usableCapital('available', {
        base: 10_000,
        cash: 100_000,
        dayPnl: 0,
        realizedPnl: 0,
        deployedOnce: false,
      })
    ).toBe(100_000)
  })

  it('a losing session shrinks what can deploy, never below zero', () => {
    expect(usableCapital('available', { ...base, dayPnl: -40_000, realizedPnl: -40_000 })).toBe(
      60_000
    )
    expect(usableCapital('available', { ...base, dayPnl: -150_000, realizedPnl: -150_000 })).toBe(0)
  })

  it('non-finite cash reads as zero so the P&L alone cannot invent money', () => {
    expect(
      usableCapital('available', { ...base, cash: Number.NaN, dayPnl: 5_000, realizedPnl: 5_000 })
    ).toBe(5_000)
  })

  it('string cash from the funds endpoint works the same as a number', () => {
    expect(
      usableCapital('available', {
        ...base,
        cash: '100000.00' as unknown as number,
        dayPnl: 9_000,
        realizedPnl: 6_500,
      })
    ).toBe(109_000)
    // And the allocation bases clamp against it instead of zeroing out —
    // the "Usable ₹0 whatever the mode" report.
    expect(
      usableCapital('initial', {
        ...base,
        cash: '100000.00' as unknown as number,
        dayPnl: 0,
        realizedPnl: 0,
      })
    ).toBe(75_000)
  })
})
