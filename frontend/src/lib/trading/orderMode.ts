/**
 * The global order mode — one setting every buy/sell reads.
 *
 * Four ways an order can reach the broker, in the trader's words:
 *
 * - **LIMIT** — the bracket entry as the deploy panel codes it: a row with an
 *   entry level rests at that level, and an order without one rides the live
 *   price as a LIMIT. The default, and the fix for "my 40 became a 45.55":
 *   no market print, no protection added on top — the price asked for is the
 *   price sent.
 * - **MPP** — market price protection with a trader-chosen percent: the live
 *   price is the base and the LIMIT carries the buffer (BUY above it, SELL
 *   below it), rounded to the exchange tick. The same idea the backend's
 *   MARKET-order slabs implement, but the percent is the user's, and the
 *   order goes out as a LIMIT so no broker slab can override it.
 * - **MARKET** — the plain market order, priced by the broker.
 * - **LIVE** — a LIMIT at the price on screen right now: no buffer, no
 *   resting-away level, just the LTP the trader is looking at.
 *
 * The mode is a zustand-persist store (the theme store's pattern) so every
 * surface — the deploy panel, the chart's instant panel, the scheduled
 * batches, the hedging terminal — reads one value that survives a reload.
 *
 * Resolution never throws: an order that cannot be priced (no LTP for a
 * LIVE/MPP/LIMIT order) falls back to MARKET rather than blocking the fire,
 * and the caller's toast tells the trader what actually went out.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type OrderMode = 'limit' | 'mpp' | 'market' | 'live'

export const ORDER_MODES: readonly { value: OrderMode; label: string; hint: string }[] = [
  {
    value: 'limit',
    label: 'LIMIT',
    hint: 'Entry level rests as a LIMIT; without one, the live price is the limit',
  },
  {
    value: 'mpp',
    label: 'MPP',
    hint: 'Market protection: LIMIT at the live price ± your percent buffer',
  },
  { value: 'market', label: 'MARKET', hint: 'Plain market order — the broker prices it' },
  { value: 'live', label: 'LIVE', hint: 'LIMIT at the price on screen right now' },
] as const

/** NSE/BSE tick for every option and equity price. */
export const TICK = 0.05

/** Round a limit price to the exchange tick, two decimals, never below zero. */
export function roundToTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  return Math.max(0, Math.round(Math.round(price / TICK) * TICK * 100) / 100)
}

/**
 * The protected limit price: the base ± the percent, on the order's side —
 * a BUY pays up to fill, a SELL gives down to fill. Tick-rounded.
 */
export function protectedPrice(base: number, action: 'BUY' | 'SELL', percent: number): number {
  const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  const filled = base * (1 + (safe / 100) * (action === 'BUY' ? 1 : -1))
  return roundToTick(filled)
}

interface OrderModeStore {
  mode: OrderMode
  /** The MPP buffer percent, applied on the live price. Default 0: the
   *  limit rests at the live price itself and the trader adds a buffer
   *  only when they want one — 3, the option slab's old default, paid up
   *  on every fill whether the market needed it or not. */
  mppPercent: number
  setMode(mode: OrderMode): void
  setMppPercent(percent: number): void
}

export const useOrderModeStore = create<OrderModeStore>()(
  persist(
    (set) => ({
      mode: 'limit',
      mppPercent: 0,
      setMode: (mode) => set({ mode }),
      setMppPercent: (mppPercent) =>
        set({ mppPercent: Math.min(100, Math.max(0, Number(mppPercent) || 0)) }),
    }),
    {
      name: 'openalgo-order-mode',
      // v0 shipped the option slab's 3% as the MPP buffer; v1 defaults to 0.
      // A stored 3 was the shipped number far more often than a choice, so
      // the migration resets it once and keeps the mode the trader picked.
      version: 1,
      migrate: (persisted) => {
        const saved = (persisted ?? {}) as Partial<OrderModeStore>
        const mode: OrderMode =
          saved.mode === 'mpp' || saved.mode === 'market' || saved.mode === 'live'
            ? saved.mode
            : 'limit'
        // The actions come from the store itself; persist merges this over them.
        return { mode, mppPercent: 0 } as OrderModeStore
      },
    }
  )
)

/** What an order carries on the wire after the mode resolved. */
export interface ResolvedPricing {
  /** The mode resolves entries and buffers only — never a stop. */
  pricetype: 'MARKET' | 'LIMIT'
  /** Undefined for a MARKET: the broker prices it. A LIMIT always carries one. */
  price?: number
  /** How the order actually went out, for toasts and the audit trail. */
  note: string
}

/**
 * Resolve one order's price type and price from the global mode.
 *
 * - `entry` — the explicit level the trader set (a deploy row's entry). It
 *   wins in LIMIT mode only: that mode is "the price asked for is the price
 *   sent".
 * - `ltp` — the live price: the MPP base, the LIVE price and the LIMIT
 *   fallback when no entry was set. Absent, anything that needed it falls
 *   back to MARKET with a note saying so.
 */
export function resolveOrderPricing(input: {
  action: 'BUY' | 'SELL'
  mode: OrderMode
  mppPercent: number
  entry?: number | null
  ltp?: number | null
}): ResolvedPricing {
  const { action, mode, mppPercent, entry, ltp } = input
  const live = ltp != null && Number.isFinite(ltp) && ltp > 0 ? ltp : null
  const level = entry != null && Number.isFinite(entry) && entry > 0 ? entry : null

  switch (mode) {
    case 'market':
      return { pricetype: 'MARKET', note: 'market order' }
    case 'mpp': {
      if (live == null)
        return {
          pricetype: 'MARKET',
          note: 'market order — no live price for the MPP buffer',
        }
      const price = protectedPrice(live, action, mppPercent)
      return {
        pricetype: 'LIMIT',
        price,
        note: `MPP ${mppPercent}% limit @ ${price}`,
      }
    }
    case 'live': {
      if (live == null) return { pricetype: 'MARKET', note: 'market order — no live price yet' }
      const price = roundToTick(live)
      return { pricetype: 'LIMIT', price, note: `live-price limit @ ${price}` }
    }
    default: {
      // LIMIT — the default: a levelled entry rests at its level, everything
      // else rides the live price as a LIMIT.
      if (level != null)
        return {
          pricetype: 'LIMIT',
          price: roundToTick(level),
          note: `limit @ ${roundToTick(level)}`,
        }
      if (live == null)
        return { pricetype: 'MARKET', note: 'market order — no level and no live price' }
      const price = roundToTick(live)
      return { pricetype: 'LIMIT', price, note: `limit @ live ${price}` }
    }
  }
}

/** The current global mode + percent, read once for a fire loop. */
export function currentOrderMode(): { mode: OrderMode; mppPercent: number } {
  const { mode, mppPercent } = useOrderModeStore.getState()
  return { mode, mppPercent }
}

/**
 * LTPs for the distinct instruments a fire batch prices — one multiquotes
 * call. A failed ask is an empty map, not an error: the resolver's market
 * fallback answers for whatever the quote layer did not, so a fire never
 * blocks on a quote.
 */
export async function fetchLtpMap(
  apiKey: string,
  instruments: readonly { symbol: string; exchange: string }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const distinct = new Map<string, { symbol: string; exchange: string }>()
  for (const { symbol, exchange } of instruments)
    distinct.set(`${exchange}:${symbol}`, { symbol, exchange })
  if (distinct.size === 0) return out
  try {
    const { tradingApi } = await import('@/api/trading')
    const res = await tradingApi.getMultiQuotes(apiKey, [...distinct.values()])
    for (const r of res.results ?? []) {
      const ltp = Number(r.data?.ltp)
      if (Number.isFinite(ltp) && ltp > 0) out.set(`${r.exchange}:${r.symbol}`, ltp)
    }
  } catch {
    // The resolver's market fallback covers the miss.
  }
  return out
}
