import { clampedBase, usableCapital } from '@/lib/hedging/capital'
import type { CapitalBasis } from '@/types/hedging'
import type { OptionChainResponse } from '@/types/option-chain'

/**
 * The deploy panel's pure side: the strike (or stock) rows the quick actions
 * fire, and where they are remembered.
 *
 * The panel is a trading surface, so everything the trader built survives a
 * reload: rows per underlying, the product / price type / lots the batch
 * fires with, and — since the capital-weighted rework — each row's share of
 * the funds. Rows are keyed by the exact trading symbol the chain snapshot
 * resolved, so a row is always a real instrument, never a guess — with one
 * deliberate exception: rows added before the chain lands carry a symbol
 * built the OpenAlgo convention (`NIFTY09NOV2617350CE`). They are flagged
 * `constructed` and the reconcile pass swaps them for the chain's exact
 * listed symbol the moment the snapshot arrives; nothing keeps firing a
 * constructed name once the real one is known.
 */

export const DEPLOY_STORAGE_KEY = 'oa-trading-deploy-v1'

export type RowKind = 'option' | 'stock'
export type RowSide = 'CE' | 'PE' | 'EQ'

export interface DeployRow {
  /** The exact option symbol from the chain snapshot (e.g. NIFTY27OCT2624500CE). */
  symbol: string
  exchange: string
  /** Options ride the strike ladder; stocks ride the flat list. */
  kind: RowKind
  /** The strike price — options only, 0 for stocks. */
  strike: number
  /** Which pane an option belongs to. Stocks store 'CE' but `kind` decides. */
  optionType: 'CE' | 'PE'
  /** Shares per lot (1 for equities). */
  lotSize: number
  enabled: boolean
  /**
   * Lots this row fires with when set; 0 sizes the row from its weight
   * share of the funds (the auto lot count).
   */
  lots: number
  /**
   * The row's percent of the trading funds inside its side. A side's
   * enabled weights always sum to 100 — CE, PE and the stock list each
   * normalize independently.
   */
  weight: number
  /** Manual entry price for P&L when no broker position exists. */
  entry: number | null
  /** Monitoring levels: the row flags when LTP crosses them. */
  target: number | null
  stoploss: number | null
  /** True while the symbol is the naming-convention build, pre-chain. */
  constructed?: boolean
  /** Display name (stock rows, search results). */
  name?: string
}

/** Where the panel's session capital comes from — the hedging chip's two sources. */
export type DeployCapitalSource = 'fixed' | 'percent'

/**
 * The session-capital basis, the hedging chip's four-mode ladder:
 * initial (allocation alone, losses shrink it), +PnL (allocation plus the
 * session's P&L), house (after the first deployment only realized profit
 * works), all (the whole account's cash plus the session P&L, no lock).
 */
export type DeployCapitalBasis = CapitalBasis

/** The session P&L inputs the withPnl / house / all bases read. */
export interface SessionPnl {
  /** Every position the books report, open or flattened. */
  dayPnl: number
  /** Flattened rows only — the profit that is actually booked. */
  realizedPnl: number
  /** Whether any deployment has fired this session (the house basis). */
  deployedOnce: boolean
}

export interface DeployBook {
  /** Keyed by `${optionsExchange}:${underlying}` so two underlyings keep their ladders. */
  books: Record<string, { ce: DeployRow[]; pe: DeployRow[] }>
  /** The stock list the panel shows when the selected symbol has no options. */
  stocks: DeployRow[]
  product: 'MIS' | 'NRML' | 'CNC'
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  lots: number
  /**
   * The session capital the weight shares divide — the title chip's popbox
   * edits these. Fixed rupees (clamped to cash) or a percent of cash.
   */
  capitalSource: DeployCapitalSource
  capitalFixed: number
  capitalPercent: number
  /** The usable-capital basis the hedging chip's ladder defines. */
  capitalBasis: DeployCapitalBasis
  /**
   * The instrument the panel is bound to — the workspace binding, not the
   * chart's. Multi-layout grids let the trader focus any pane without the
   * panel following it; only the title combobox moves this binding, and it
   * survives a reload.
   */
  workspace?: { symbol: string; exchange: string }
}

export function bookKey(exchange: string, underlying: string): string {
  return `${exchange}:${underlying}`
}

export const STOCK_BOOK_KEY = 'EQ:EQ'

export function defaultDeployState(): DeployBook {
  return {
    books: {},
    stocks: [],
    product: 'MIS',
    pricetype: 'MARKET',
    lots: 1,
    // Percent of cash at 100 is the no-surprise default: until the trader
    // opens the chip the panel divides exactly what the funds snapshot shows.
    capitalSource: 'percent',
    capitalFixed: 0,
    capitalPercent: 100,
    // Percent of cash under the initial basis is the no-surprise default:
    // until the trader touches the chip the panel divides exactly what the
    // funds snapshot shows, never the session's P&L on top.
    capitalBasis: 'initial',
  }
}

/**
 * The rupees the weight shares divide, under the chip's two choices:
 *
 * - the source — a fixed rupee allocation (clamped to what the account
 *   holds) or a percent of cash — sets the allocation, and
 * - the basis — the hedging chip's four-mode ladder — turns that allocation
 *   into the usable figure, folding the session's P&L in (or locking it out)
 *   the way `usableCapital` defines it.
 *
 * Cash the funds snapshot has not delivered yet reads as 0 — a fixed
 * capital still works (it is the trader's own number), a percent reads 0
 * until funds land, which is the honest answer. The funds endpoint answers
 * with strings, so every cash value is coerced before the arithmetic.
 */
export function usableSessionCapital(
  state: Pick<DeployBook, 'capitalSource' | 'capitalFixed' | 'capitalPercent' | 'capitalBasis'>,
  cash: number,
  session?: SessionPnl
): number {
  const safeCash = Number.isFinite(cash) && cash > 0 ? cash : 0
  const pnl = session ?? { dayPnl: 0, realizedPnl: 0, deployedOnce: false }
  const basis = state.capitalBasis ?? 'initial'
  if (state.capitalSource === 'fixed') {
    const fixed = Number.isFinite(state.capitalFixed) ? state.capitalFixed : 0
    // The old contract stands: a fixed capital is the trader's own number and
    // keeps working while the funds snapshot has not landed. `usableCapital`
    // clamps every allocation to known cash — with none known there is
    // nothing to clamp against, so the ladder runs against the fixed amount
    // directly (identical shapes, minus the clamp).
    if (safeCash <= 0) {
      switch (basis) {
        case 'initial':
          return Math.max(0, fixed + Math.min(0, pnl.realizedPnl))
        case 'withPnl':
          return Math.max(0, fixed + pnl.dayPnl)
        case 'house':
          return pnl.deployedOnce ? Math.max(0, pnl.realizedPnl) : fixed
        case 'available':
          // No cash known: the session P&L alone, never invented money.
          return Math.max(0, pnl.dayPnl)
      }
    }
    return usableCapital(basis, {
      base: clampedBase(fixed, safeCash),
      cash: safeCash,
      dayPnl: pnl.dayPnl,
      realizedPnl: pnl.realizedPnl,
      deployedOnce: pnl.deployedOnce,
    })
  }
  const pct = Number.isFinite(state.capitalPercent) ? state.capitalPercent : 100
  return usableCapital(state.capitalBasis ?? 'initial', {
    base: (safeCash * Math.min(100, Math.max(0, pct))) / 100,
    cash: safeCash,
    dayPnl: pnl.dayPnl,
    realizedPnl: pnl.realizedPnl,
    deployedOnce: pnl.deployedOnce,
  })
}

/** Which side of the book (or the stock list) a row belongs to. */
export function sideOfRow(row: DeployRow): RowSide {
  return row.kind === 'stock' ? 'EQ' : row.optionType
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function hydrateWorkspace(raw: unknown): DeployBook['workspace'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return undefined
  return {
    symbol: r.symbol,
    exchange: typeof r.exchange === 'string' && r.exchange ? r.exchange : 'NSE',
  }
}

function hydrateRow(raw: unknown, defaultKind: RowKind): DeployRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) return null
  const kind: RowKind = r.kind === 'stock' || r.kind === 'option' ? r.kind : defaultKind
  const optionType = r.optionType === 'PE' ? 'PE' : 'CE'
  const strike = num(r.strike, 0)
  if (kind === 'option' && (!Number.isFinite(strike) || strike <= 0)) return null
  return {
    symbol: r.symbol,
    exchange:
      typeof r.exchange === 'string' && r.exchange ? r.exchange : kind === 'stock' ? 'NSE' : 'NFO',
    kind,
    strike,
    optionType,
    lotSize: num(r.lotSize, 0) > 0 ? num(r.lotSize, 0) : 1,
    enabled: r.enabled !== false,
    lots: num(r.lots, 0) > 0 ? Math.floor(num(r.lots, 0)) : 0,
    weight: Math.max(0, num(r.weight, 0)),
    entry: nullableNum(r.entry),
    target: nullableNum(r.target),
    stoploss: nullableNum(r.stoploss),
    constructed: r.constructed === true,
    name: typeof r.name === 'string' ? r.name : undefined,
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
  if (r.capitalSource === 'fixed' || r.capitalSource === 'percent')
    base.capitalSource = r.capitalSource
  const fixed = Number(r.capitalFixed)
  if (Number.isFinite(fixed) && fixed >= 0) base.capitalFixed = fixed
  const pct = Number(r.capitalPercent)
  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) base.capitalPercent = pct
  if (
    r.capitalBasis === 'initial' ||
    r.capitalBasis === 'withPnl' ||
    r.capitalBasis === 'house' ||
    r.capitalBasis === 'available'
  )
    base.capitalBasis = r.capitalBasis
  if (typeof r.books === 'object' && r.books !== null) {
    const side = (list: unknown): DeployRow[] =>
      Array.isArray(list)
        ? list
            .map((item) => hydrateRow(item, 'option'))
            .filter((row): row is DeployRow => row !== null)
        : []
    for (const [key, value] of Object.entries(r.books as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const v = value as Record<string, unknown>
      base.books[key] = { ce: side(v.ce), pe: side(v.pe) }
    }
  }
  if (Array.isArray(r.stocks)) {
    base.stocks = r.stocks
      .map((item) => hydrateRow(item, 'stock'))
      .filter((row): row is DeployRow => row !== null)
      .map((row) => ({ ...row, kind: 'stock' as const }))
  }
  base.workspace = hydrateWorkspace(r.workspace)
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

/* ── the weight engine: every side sums to 100, automatically ─────────────── */

/**
 * Rescale each side's enabled weights so CE, PE and the stock list each sum
 * to exactly 100 (one decimal). Runs after every add, remove and toggle, so
 * the trader never has to make the shares add up.
 */
export function normalizeSideWeights(rows: DeployRow[]): DeployRow[] {
  const groups = new Map<RowSide, number>()
  for (const row of rows) {
    if (!row.enabled) continue
    const side = sideOfRow(row)
    groups.set(side, (groups.get(side) ?? 0) + Math.max(0, row.weight))
  }
  return rows.map((row) => {
    if (!row.enabled) return row
    const side = sideOfRow(row)
    const total = groups.get(side) ?? 0
    if (total <= 0) return row
    const scaled = (Math.max(0, row.weight) / total) * 100
    return { ...row, weight: Math.round(scaled * 10) / 10 }
  })
}

/**
 * Even split for one side's enabled rows — the auto allocation a fresh or
 * re-balanced side starts from. Three rows land at 33.3 each and the last
 * carries the rounding residue, so the side still reads 100.
 */
export function equalSplitSide(rows: DeployRow[], side: RowSide): DeployRow[] {
  const members = rows.filter((row) => row.enabled && sideOfRow(row) === side)
  if (members.length === 0) return rows
  // One-decimal share: 2 rows → 50, 3 rows → 33.3, and the last member
  // carries the rounding residue so the side still reads 100.
  const share = Math.floor(1000 / members.length) / 10
  let assigned = 0
  return rows.map((row) => {
    if (!row.enabled || sideOfRow(row) !== side) return row
    const isLast = row === members[members.length - 1]
    const weight = isLast ? Math.round((100 - assigned) * 10) / 10 : share
    assigned += weight
    return { ...row, weight: Math.max(0, weight) }
  })
}

/**
 * Slide one row's weight to `value` and re-level its side's other enabled
 * rows so the side still sums to 100.
 *
 * The remainder splits proportionally to what the others carry — but a row
 * pushed to 100 collapses the rest to 0, and a proportional re-level of
 * zeros stays zero forever: sliding back down would leave the side short.
 * So when the others carry nothing (all collapsed, or fresh rows at 0),
 * the remainder splits evenly across them instead. Either way the side
 * always reads 100 and every enabled row can fire.
 */
export function slideSideWeight(rows: DeployRow[], symbol: string, value: number): DeployRow[] {
  const target = rows.find((row) => row.symbol === symbol)
  if (!target) return rows
  const clamped = Math.min(100, Math.max(1, Math.round(value * 10) / 10))
  const side = sideOfRow(target)
  const others = rows.filter(
    (row) => row.symbol !== symbol && row.enabled && sideOfRow(row) === side
  )
  const othersTotal = others.reduce((sum, row) => sum + Math.max(0, row.weight), 0)
  const remainder = Math.round((100 - clamped) * 10) / 10
  const evenShare = others.length > 0 ? Math.floor((remainder * 10) / others.length) / 10 : 0
  return rows.map((row) => {
    if (row.symbol === symbol) return { ...row, weight: clamped }
    if (!row.enabled || sideOfRow(row) !== side) return row
    if (othersTotal <= 0) return { ...row, weight: evenShare }
    const scaled = (Math.max(0, row.weight) / othersTotal) * remainder
    return { ...row, weight: Math.round(scaled * 10) / 10 }
  })
}

/**
 * Enable or disable one row and re-level its side back to 100 in the same
 * stroke — the checkbox's share does not wait for the trader to drag a
 * slider.
 *
 * Enabling a row that carries no weight (fresh from the add strip, or
 * collapsed away earlier) hands it an even share and shrinks the rows that
 * were carrying the side; enabling one that still carries a weight folds it
 * back in with the plain rescale. Disabling renormalises what remains, and
 * a side whose remainder sums to nothing takes the even split. Every path
 * leaves the side's enabled weights summing to 100 (a side with no enabled
 * rows stays untouched — there is nothing to level).
 */
export function toggleSideRow(rows: DeployRow[], symbol: string): DeployRow[] {
  const target = rows.find((row) => row.symbol === symbol)
  if (!target) return rows
  const side = sideOfRow(target)
  const flipped = rows.map((row) =>
    row.symbol === symbol ? { ...row, enabled: !row.enabled } : row
  )
  const enabled = flipped.filter((row) => row.enabled && sideOfRow(row) === side)
  if (enabled.length === 0) return flipped
  const total = enabled.reduce((sum, row) => sum + Math.max(0, row.weight), 0)
  if (total <= 0) return equalSplitSide(flipped, side)
  // A row switched on with nothing to its name takes an even share out of
  // the side before the rescale, or the rescale of zeros would leave it 0.
  const joined = flipped.map((row) => {
    if (row.symbol !== symbol || !row.enabled || sideOfRow(row) !== side) return row
    if (Math.max(0, row.weight) > 0) return row
    const share = Math.floor((100 * 10) / enabled.length) / 10
    return { ...row, weight: share }
  })
  return normalizeSideWeights(joined)
}

/**
 * A side whose enabled rows carry no weights at all (a ladder saved before
 * the capital rework) gets its even split on load — every side always sums
 * to 100, even a book that predates the weights.
 */
export function ensureSideWeights(state: DeployBook): DeployBook {
  const fix = (rows: DeployRow[], side: RowSide): DeployRow[] => {
    const total = rows.reduce(
      (sum, row) => (row.enabled && sideOfRow(row) === side ? sum + row.weight : sum),
      0
    )
    const hasRows = rows.some((row) => row.enabled && sideOfRow(row) === side)
    return hasRows && total <= 0 ? equalSplitSide(rows, side) : rows
  }
  const books: DeployBook['books'] = {}
  for (const [key, ladder] of Object.entries(state.books)) {
    books[key] = {
      ce: fix(ladder.ce ?? [], 'CE'),
      pe: fix(ladder.pe ?? [], 'PE'),
    }
  }
  return { ...state, books, stocks: fix(state.stocks ?? [], 'EQ') }
}

/* ── sizing: weight % of the funds → lots or shares ──────────────────────── */

/** Whole lots (or shares, lotSize 1) the row's weight share of the funds buys. */
export function autoLots(row: DeployRow, ltp: number | undefined, capital: number): number {
  if (!ltp || !Number.isFinite(ltp) || ltp <= 0 || capital <= 0 || row.weight <= 0) return 0
  const budget = (capital * row.weight) / 100
  const perLot = ltp * row.lotSize
  if (!Number.isFinite(perLot) || perLot <= 0) return 0
  return Math.floor(budget / perLot)
}

/** The quantity a row fires: manual lots win, otherwise the weight auto size. */
export function rowQty(row: DeployRow, ltp: number | undefined, capital: number): number {
  const lots = row.lots > 0 ? row.lots : autoLots(row, ltp, capital)
  if (lots <= 0) return 0
  return lots * row.lotSize
}

/**
 * The rupees this row needs to buy its planned quantity at the live price —
 * the sizing row's number (quantity x LTP), 0 when nothing can be sized.
 */
export function rowRequired(row: DeployRow, ltp: number | undefined, capital: number): number {
  const qty = rowQty(row, ltp, capital)
  if (qty <= 0 || ltp === undefined || !Number.isFinite(ltp) || ltp <= 0) return 0
  return qty * ltp
}

/* ── symbols built before the chain lands ────────────────────────────────── */

/**
 * The OpenAlgo option symbol from parts: `NIFTY` + `09NOV26` (dash-free) +
 * `17350` + `CE`. The expiry may arrive dashed (`09-NOV-26`) — the dashes
 * belong to the expiry column, never to the symbol.
 */
export function constructedOptionSymbol(
  base: string,
  expiry: string,
  strike: number,
  optionType: 'CE' | 'PE'
): string {
  const compact = String(expiry || '')
    .replace(/-/g, '')
    .toUpperCase()
  return `${base.toUpperCase()}${compact}${Math.round(strike)}${optionType}`
}

/**
 * Default strike intervals for the common underlyings — the grid the ATM
 * and the offset picks land on before (or without) the chain snapshot.
 * The chain's own strike spacing overrides this the moment it arrives.
 */
export const STRIKE_STEPS: Readonly<Record<string, number>> = {
  NIFTY: 50,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  BANKNIFTY: 100,
  NIFTYNXT50: 100,
  SENSEX: 100,
  BANKEX: 100,
  SENSEX50: 100,
  GOLD: 100,
  GOLDM: 50,
  SILVER: 250,
  SILVERM: 50,
  CRUDEOIL: 100,
  NATURALGAS: 25,
  COPPER: 5,
  ZINC: 5,
  LEAD: 5,
  NICKEL: 25,
  ALUMINIUM: 5,
}

/**
 * Default lot sizes for the same underlyings — the per-lot size rows carry
 * before the chain (or a search hit) reports the exchange's current value.
 * Defaults only seed the display; every resolution path overwrites them.
 */
export const DEFAULT_LOT_SIZES: Readonly<Record<string, number>> = {
  NIFTY: 75,
  FINNIFTY: 65,
  MIDCPNIFTY: 140,
  BANKNIFTY: 35,
  NIFTYNXT50: 25,
  SENSEX: 20,
  BANKEX: 30,
  SENSEX50: 60,
  GOLD: 100,
  GOLDM: 10,
  SILVER: 30,
  SILVERM: 5,
  CRUDEOIL: 100,
  NATURALGAS: 1250,
  COPPER: 2500,
  ZINC: 5000,
  LEAD: 5000,
  NICKEL: 1500,
  ALUMINIUM: 5000,
}

export function defaultStrikeStep(base: string): number {
  return STRIKE_STEPS[base.toUpperCase()] ?? 50
}

export function defaultLotSize(base: string): number {
  return DEFAULT_LOT_SIZES[base.toUpperCase()] ?? 1
}

/* ── rows in and out of the book ─────────────────────────────────────────── */

/**
 * Turn wanted strikes into rows, resolving each through the chain snapshot.
 *
 * A strike the snapshot does not list is skipped, not invented: the panel
 * trades what the exchange lists, the way the hedging terminal's resolver
 * does. Existing rows with the same symbol keep their enabled / lots /
 * weight choices, and prior rows the narrower snapshot no longer lists stay
 * put — the trader placed them and a refresh must not silently unwind the
 * ladder.
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
  const kept = existing.filter((row) => row.optionType === side && row.kind !== 'stock')
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
      fresh.push({ ...prior, lotSize: leg.lotsize, constructed: false })
      continue
    }
    fresh.push({
      symbol: leg.symbol,
      exchange,
      kind: 'option',
      strike,
      optionType: side,
      lotSize: leg.lotsize,
      enabled: true,
      lots: 0,
      weight: 0,
      entry: null,
      target: null,
      stoploss: null,
    })
  }
  for (const row of bySymbol.values()) fresh.push(row)
  fresh.sort((a, b) => a.strike - b.strike)
  return { rows: fresh, skipped }
}

/**
 * Add wanted strikes without waiting for a chain snapshot: every strike
 * becomes a row whose symbol is built the OpenAlgo convention and flagged
 * `constructed`. The reconcile pass below swaps each one for the chain's
 * exact listed symbol when the snapshot arrives, so a strike added early is
 * never added twice.
 */
export function constructedRows(
  side: 'CE' | 'PE',
  wanted: number[],
  opts: { base: string; expiry: string; exchange: string; lotSize?: number },
  existing: DeployRow[] = []
): DeployRow[] {
  const lotSize = opts.lotSize && opts.lotSize > 0 ? opts.lotSize : defaultLotSize(opts.base)
  const byStrike = new Map(existing.filter((r) => r.kind !== 'stock').map((r) => [r.strike, r]))
  const fresh: DeployRow[] = []
  for (const strike of wanted) {
    const prior = byStrike.get(strike)
    if (prior) {
      byStrike.delete(strike)
      fresh.push(prior)
      continue
    }
    fresh.push({
      symbol: constructedOptionSymbol(opts.base, opts.expiry, strike, side),
      exchange: opts.exchange,
      kind: 'option',
      strike,
      optionType: side,
      lotSize,
      enabled: true,
      lots: 0,
      weight: 0,
      entry: null,
      target: null,
      stoploss: null,
      constructed: true,
    })
  }
  for (const row of byStrike.values()) fresh.push(row)
  fresh.sort((a, b) => a.strike - b.strike)
  return fresh
}

/**
 * Promote constructed rows to the chain's exact listed symbols. A strike
 * the chain lists swaps in the listed symbol and lot size; a strike it does
 * not list stays constructed (it may still trade once the master contract
 * carries it). Settings — enabled, lots, weight, levels — ride across.
 */
export function reconcileConstructed(
  chain: Pick<OptionChainResponse, 'chain'> | null,
  existing: DeployRow[],
  exchange = 'NFO'
): { rows: DeployRow[]; promoted: number } {
  if (!chain) return { rows: existing, promoted: 0 }
  let promoted = 0
  const rows = existing.map((row) => {
    if (!row.constructed) return row
    const at = chain.chain.find((c) => c.strike === row.strike)
    const leg = row.optionType === 'CE' ? at?.ce : at?.pe
    if (!leg?.symbol) return row
    promoted += 1
    return {
      ...row,
      symbol: leg.symbol,
      lotSize: leg.lotsize || row.lotSize,
      exchange,
      constructed: false,
    }
  })
  return { rows, promoted }
}

/**
 * The FNO base of an OpenAlgo derivative symbol: `NIFTY27OCT2624500CE` and
 * `NIFTY27OCT26FUT` both resolve to `NIFTY`, while a plain symbol
 * (`NIFTY`, `MIDCPNIFTY`, `RELIANCE`) comes back as itself. The expiry
 * block is the date the convention always appends (`27OCT26`) — requiring
 * it is what keeps a plain equity like RELIANCE (which ends in "CE") from
 * reading as a derivative of "RELIAN".
 */
export function fnoBaseSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase()
  const match = /^(.+?)\d{2}[A-Z]{3}\d{2}\d*(?:CE|PE|FUT)$/i.exec(upper)
  return match ? match[1] : upper
}

/** A stock row from a search hit — shares, no strike, weight auto-split. */
export function stockRowFromSearch(hit: {
  symbol: string
  exchange: string
  lotsize?: number
  name?: string
}): DeployRow {
  return {
    symbol: hit.symbol,
    exchange: hit.exchange || 'NSE',
    kind: 'stock',
    strike: 0,
    optionType: 'CE',
    lotSize: hit.lotsize && hit.lotsize > 0 ? hit.lotsize : 1,
    enabled: true,
    lots: 0,
    weight: 0,
    entry: null,
    target: null,
    stoploss: null,
    name: hit.name,
  }
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

export interface Sizing {
  /** The trading funds the weight shares divide (the funds snapshot's cash). */
  capital?: number
  /** LTP lookup for auto sizing — the chain or the quotes feed. */
  ltpOf?(row: DeployRow): number | undefined
}

/**
 * One side's firing list: the enabled rows only. Manual lots win; a row its
 * weight cannot carry (premium too rich for its share) drops out rather
 * than firing a lot the funds do not back.
 */
export function firingRows(
  rows: DeployRow[],
  sizing?: Sizing
): Array<{ row: DeployRow; qty: number }> {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({
      row,
      qty: rowQty(row, sizing?.ltpOf?.(row), sizing?.capital ?? 0),
    }))
    .filter((entry) => entry.qty > 0)
}
