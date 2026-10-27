import type { OptionChainResponse } from '@/types/option-chain'

/**
 * The deploy panel's pure side: the strike rows the quick actions fire, and
 * where they are remembered.
 *
 * The panel is a trading surface, so everything the trader built survives a
 * reload: rows per underlying, and the product / price type / lots the batch
 * fires with. Rows are keyed by the exact trading symbol the chain snapshot
 * resolved, so a row is always a real instrument, never a constructed name —
 * the same contract the hedging terminal's panels follow.
 */

export const DEPLOY_STORAGE_KEY = 'oa-trading-deploy-v1'

export interface DeployRow {
  /** The exact option symbol from the chain snapshot (e.g. NIFTY27OCT2624500CE). */
  symbol: string
  exchange: string
  strike: number
  optionType: 'CE' | 'PE'
  lotSize: number
  enabled: boolean
  /** Lots this row fires with when set; 0 falls back to the batch lots. */
  lots: number
}

export interface DeployBook {
  /** Keyed by `${optionsExchange}:${underlying}` so two underlyings keep their ladders. */
  books: Record<string, { ce: DeployRow[]; pe: DeployRow[] }>
  product: 'MIS' | 'NRML' | 'CNC'
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  lots: number
}

export function bookKey(exchange: string, underlying: string): string {
  return `${exchange}:${underlying}`
}

export function defaultDeployState(): DeployBook {
  return { books: {}, product: 'MIS', pricetype: 'MARKET', lots: 1 }
}

function hydrateRow(raw: unknown): DeployRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null
  if (r.optionType !== 'CE' && r.optionType !== 'PE') return null
  const strike = Number(r.strike)
  if (!Number.isFinite(strike) || strike <= 0) return null
  return {
    symbol: r.symbol,
    exchange: typeof r.exchange === 'string' ? r.exchange : 'NFO',
    strike,
    optionType: r.optionType,
    lotSize: Number.isFinite(Number(r.lotSize)) && Number(r.lotSize) > 0 ? Number(r.lotSize) : 1,
    enabled: r.enabled !== false,
    lots: Number.isFinite(Number(r.lots)) && Number(r.lots) > 0 ? Number(r.lots) : 0,
  }
}

/** A stored snapshot merged over defaults, so a partial write cannot half-form a panel. */
export function hydrateDeployState(raw: unknown): DeployBook {
  const base = defaultDeployState()
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  if (r.product === 'MIS' || r.product === 'NRML' || r.product === 'CNC') base.product = r.product
  if (
    r.pricetype === 'MARKET' ||
    r.pricetype === 'LIMIT' ||
    r.pricetype === 'SL' ||
    r.pricetype === 'SL-M'
  )
    base.pricetype = r.pricetype
  const lots = Number(r.lots)
  if (Number.isFinite(lots) && lots >= 1) base.lots = Math.floor(lots)
  if (typeof r.books === 'object' && r.books !== null) {
    const side = (list: unknown): DeployRow[] =>
      Array.isArray(list)
        ? list.map(hydrateRow).filter((row): row is DeployRow => row !== null)
        : []
    for (const [key, value] of Object.entries(r.books as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const v = value as Record<string, unknown>
      base.books[key] = { ce: side(v.ce), pe: side(v.pe) }
    }
  }
  return base
}

export function readDeployState(storage: Pick<Storage, 'getItem'> = localStorage): DeployBook {
  try {
    const raw = storage.getItem(DEPLOY_STORAGE_KEY)
    return raw ? hydrateDeployState(JSON.parse(raw)) : defaultDeployState()
  } catch {
    return defaultDeployState()
  }
}

export function writeDeployState(
  state: DeployBook,
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(DEPLOY_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or private mode: the panel keeps working, persistence resumes later.
  }
}

/**
 * Turn wanted strikes into rows, resolving each through the chain snapshot.
 *
 * A strike the snapshot does not list is skipped, not invented: the panel
 * trades what the exchange lists, the way the hedging terminal's resolver
 * does. Existing rows with the same symbol keep their enabled / lots choices,
 * and prior rows the narrower snapshot no longer lists stay put — the trader
 * placed them and a refresh must not silently unwind the ladder.
 */
export function rowsFromStrikes(
  chain: Pick<OptionChainResponse, 'chain'> | null,
  side: 'CE' | 'PE',
  wanted: number[],
  existing: DeployRow[] = [],
  exchange = 'NFO'
): { rows: DeployRow[]; skipped: number[] } {
  const byStrike = new Map<number, { symbol: string; lotsize: number }>()
  if (chain) {
    for (const row of chain.chain) {
      const leg = side === 'CE' ? row.ce : row.pe
      if (leg?.symbol) byStrike.set(row.strike, { symbol: leg.symbol, lotsize: leg.lotsize || 1 })
    }
  }
  const kept = existing.filter((row) => row.optionType === side)
  const bySymbol = new Map(kept.map((row) => [row.symbol, row]))
  const fresh: DeployRow[] = []
  const skipped: number[] = []
  for (const strike of wanted) {
    const leg = byStrike.get(strike)
    if (!leg) {
      skipped.push(strike)
      continue
    }
    const prior = bySymbol.get(leg.symbol)
    if (prior) {
      bySymbol.delete(leg.symbol)
      fresh.push(prior)
      continue
    }
    fresh.push({
      symbol: leg.symbol,
      exchange,
      strike,
      optionType: side,
      lotSize: leg.lotsize,
      enabled: true,
      lots: 0,
    })
  }
  for (const row of bySymbol.values()) fresh.push(row)
  fresh.sort((a, b) => a.strike - b.strike)
  return { rows: fresh, skipped }
}

/** The last price of a row from a chain snapshot, when the leg is still listed. */
export function chainLtp(
  chain: Pick<OptionChainResponse, 'chain'> | null,
  symbol: string
): number | undefined {
  if (!chain) return undefined
  for (const row of chain.chain) {
    if (row.ce?.symbol === symbol) return row.ce.ltp
    if (row.pe?.symbol === symbol) return row.pe.ltp
  }
  return undefined
}

/** One side's firing list: the enabled rows only, with the batch lots default. */
export function firingRows(
  rows: DeployRow[],
  batchLots: number
): Array<{ row: DeployRow; qty: number }> {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({ row, qty: (row.lots || batchLots) * row.lotSize }))
    .filter((entry) => entry.qty > 0)
}
