import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimEngineLock, releaseEngineLock } from './engineLock'

/**
 * The lock's promises, pinned: one holder at a time, staleness hands the
 * lock over, release only drops your own, and refused storage reads as a
 * single-tab session (the engine still runs).
 */

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('claimEngineLock', () => {
  it('admits the first claimant and holds it against another', () => {
    expect(claimEngineLock('trading', 'a', 1000)).toBe(true)
    expect(claimEngineLock('trading', 'b', 1500)).toBe(false)
    // Refreshing your own claim stays true.
    expect(claimEngineLock('trading', 'a', 1800)).toBe(true)
  })

  it('hands a stale heartbeat to the next claimant', () => {
    expect(claimEngineLock('trading', 'a', 1000)).toBe(true)
    // Past the TTL (4000ms) the holder counts as gone.
    expect(claimEngineLock('trading', 'b', 1000 + 4001)).toBe(true)
  })

  it('scopes locks per engine, so hedging and trading never contend', () => {
    expect(claimEngineLock('hedging', 'h', 1000)).toBe(true)
    expect(claimEngineLock('trading', 't', 1000)).toBe(true)
  })

  it('runs the engine when storage is refused', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('refused')
      },
      setItem: () => {
        throw new Error('refused')
      },
      removeItem: () => {},
    })
    expect(claimEngineLock('trading', 'a', 1000)).toBe(true)
  })
})

describe('releaseEngineLock', () => {
  it('drops the lock so the next claimant wins immediately', () => {
    claimEngineLock('trading', 'a', 1000)
    releaseEngineLock('trading', 'a')
    expect(claimEngineLock('trading', 'b', 1100)).toBe(true)
  })

  it('ignores a release from an instance that does not hold the lock', () => {
    claimEngineLock('trading', 'a', 1000)
    releaseEngineLock('trading', 'b')
    expect(claimEngineLock('trading', 'b', 1100)).toBe(false)
  })
})
