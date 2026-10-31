// ============================================================
// OpenAlgo REST adapter for the vendored quanttrade terminal.
//
// The upstream quanttrade UI talks to its own Flask `/pyapi`
// backend. Inside OpenAlgo the same `api` surface is served from
// OpenAlgo's `/api/v1` endpoints (session cookie + `apikey` body
// auth). This module keeps every exported TYPE and the `api`
// method names identical to upstream so the ported panels compile
// unchanged, while the transport beneath is OpenAlgo.
// ============================================================

import { constituentsFor } from '@/lib/hedging/indexConstituents'
import type {
  AccountSnapshot,
  Candle,
  MasterOrderResult,
  OrderLegResult,
  OrderSide,
  PositionRecord,
  Timeframe,
} from './types'

// ------------------------------------------------------------
// credentials + identity (OpenAlgo session)
// ------------------------------------------------------------

const g = globalThis as unknown as {
  __qdApiKey: string
  __qdIdentity: { username: string; broker: string }
  __qdExchangeCache: Map<string, string>
  __qdLotCache: Map<string, number>
  __qdFundsCache: { ts: number; data: FundRow[] } | null
  __qdSearchCache: Map<string, { ts: number; rows: SearchApiRow[] }>
  __qdExpCache: Map<string, string[]>
}
if (!g.__qdExchangeCache) g.__qdExchangeCache = new Map()
if (!g.__qdLotCache) g.__qdLotCache = new Map()
if (!g.__qdSearchCache) g.__qdSearchCache = new Map()
if (!g.__qdExpCache) g.__qdExpCache = new Map()
if (!g.__qdExpCache) g.__qdExpCache = new Map()

export function setApiKey(key: string) {
  g.__qdApiKey = key
}
export function getApiKey(): string {
  return g.__qdApiKey ?? ''
}
export function setIdentity(username: string, broker: string) {
  g.__qdIdentity = { username: username || 'trader', broker: broker || 'openalgo' }
}
function identity(): { username: string; broker: string } {
  return g.__qdIdentity ?? { username: 'trader', broker: 'openalgo' }
}

// ------------------------------------------------------------
// symbol → exchange / lot-size resolution
// ------------------------------------------------------------

const INDEX_EXCHANGE: Record<string, string> = {
  NIFTY: 'NSE',
  FINNIFTY: 'NSE',
  MIDCPNIFTY: 'NSE',
  NIFTYNXT50: 'NSE',
  INDIAVIX: 'NSE',
  SENSEX: 'BSE',
  BANKEX: 'BSE',
  SENSEX50: 'BSE',
}
const DERIVATIVE_EXCHANGE: Record<string, string> = {
  NIFTY: 'NFO',
  FINNIFTY: 'NFO',
  MIDCPNIFTY: 'NFO',
  NIFTYNXT50: 'NFO',
  SENSEX: 'BFO',
  BANKEX: 'BFO',
  SENSEX50: 'BFO',
}
const MCX_ROOTS = new Set([
  'CRUDEOIL',
  'GOLD',
  'GOLDM',
  'GOLDPETAL',
  'SILVER',
  'SILVERM',
  'SILVERMIC',
  'NATURALGAS',
  'COPPER',
  'ZINC',
  'ALUMINIUM',
  'LEAD',
  'NICKEL',
  'COTTONCNDY',
  'MENTHAOIL',
  'CRUDEOILM',
  'NATURALGASM',
])
const CDS_ROOTS = new Set(['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'EURUSD', 'GBPUSD', 'USDJPY'])

/** Root of an F&O contract symbol: NIFTY29OCT2625500CE → NIFTY, RELIANCE28JAN26FUT → RELIANCE. */
export function contractRoot(symbol: string): string {
  return symbol.replace(/(\d{2}[A-Z]{3}\d{2,4})?\d*(CE|PE|FUT)$/i, '').toUpperCase()
}

function guessExchange(symbol: string): string {
  const s = symbol.toUpperCase()
  if (INDEX_EXCHANGE[s]) return INDEX_EXCHANGE[s]
  const isOption = /(CE|PE)$/.test(s)
  const isFut = /FUT$/.test(s)
  if (isOption || isFut) {
    const root = contractRoot(s)
    if (DERIVATIVE_EXCHANGE[root]) return DERIVATIVE_EXCHANGE[root]
    if (MCX_ROOTS.has(root)) return 'MCX'
    if (CDS_ROOTS.has(root)) return 'CDS'
    return 'NFO'
  }
  if (MCX_ROOTS.has(s)) return 'MCX'
  if (CDS_ROOTS.has(s)) return 'CDS'
  return 'NSE'
}

/** Register the exchange for a symbol (search results, chain meta, picker). */
export function registerExchange(symbol: string, exchange: string) {
  if (symbol && exchange) g.__qdExchangeCache.set(symbol.toUpperCase(), exchange.toUpperCase())
}
export function getExchange(symbol: string): string | undefined {
  return g.__qdExchangeCache.get(symbol.toUpperCase())
}
export function resolveExchange(symbol: string): string {
  const s = symbol.toUpperCase()
  return g.__qdExchangeCache.get(s) ?? guessExchange(s)
}
export function registerLotSize(symbol: string, lotSize: number) {
  if (symbol && lotSize > 0) g.__qdLotCache.set(symbol.toUpperCase(), lotSize)
}
export function getLotSize(symbol: string): number | undefined {
  return g.__qdLotCache.get(symbol.toUpperCase())
}

// ------------------------------------------------------------
// transport
// ------------------------------------------------------------

async function j<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  const status = data.status as string | undefined
  if (!res.ok || status === 'error') {
    const d = data as { message?: string; error?: string; detail?: string }
    throw new Error(d.message || d.detail || d.error || `HTTP ${res.status}`)
  }
  return data as T
}

/** POST /api/v1<path> with the session apikey injected. */
export async function oaPost<T>(
  path: string,
  body: Record<string, unknown> = {},
  retries = 1
): Promise<T> {
  const payload = { apikey: getApiKey(), ...body }
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await j<T>(
        await fetch(`/api/v1${path}`, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      )
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : ''
      const transient = /HTTP 5|Failed to fetch|NetworkError|Load failed/i.test(msg)
      if (!transient || attempt === retries) break
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0))
  return Number.isFinite(n) ? n : 0
}

// ------------------------------------------------------------
// search (also feeds the exchange / lot-size caches)
// ------------------------------------------------------------

interface SearchApiRow {
  symbol: string
  name: string
  exchange: string
  expiry?: string | null
  strike?: number | null
  lotsize?: number | null
  instrumenttype?: string | null
  optiontype?: string | null
  brsymbol?: string
  token?: string | null
}
export interface SearchRowQt {
  symbol: string
  name: string
  exchange: string
  expiry?: string | null
  strike?: number | null
  lotSize: number
  instrumentType: string
  optionType?: string | null
}

async function rawSearch(query: string, exchange?: string): Promise<SearchApiRow[]> {
  const key = `${query}|${exchange ?? ''}`.toUpperCase()
  const hit = g.__qdSearchCache.get(key)
  if (hit && Date.now() - hit.ts < 60_000) return hit.rows
  const r = await oaPost<{ data?: SearchApiRow[] }>(
    '/search',
    { query, ...(exchange ? { exchange } : {}) },
    0
  )
  const rows = r.data ?? []
  g.__qdSearchCache.set(key, { ts: Date.now(), rows })
  for (const row of rows) {
    registerExchange(row.symbol, row.exchange)
    if (row.lotsize) registerLotSize(row.symbol, num(row.lotsize))
  }
  return rows
}

function rowToSymbolRow(r: SearchApiRow): SymbolRow {
  return {
    id: `${r.exchange}:${r.symbol}`,
    symbol: r.symbol,
    name: r.name ?? '',
    exchange: r.exchange,
    instrumentType: r.instrumenttype ?? '',
    expiry: r.expiry ?? null,
    strike: r.strike != null ? num(r.strike) : null,
    optionType: r.optiontype ?? null,
    lotSize: num(r.lotsize) || 1,
    basePrice: null,
    mappings: [],
  }
}

// ------------------------------------------------------------
// exported response types (same shapes as upstream quanttrade)
// ------------------------------------------------------------

export interface AccountRow extends AccountSnapshot {
  clientId: string | null
  modeLabel: string | null
}

export interface BrokerCatalogField {
  key: string
  label: string
  secret?: boolean
  hint?: string
  sample?: string
}
export interface BrokerCatalogEntry {
  broker: string
  label: string
  kind: 'plugin'
  fields: BrokerCatalogField[]
  login_url_template: string | null
  auth_params: string[]
}
export interface BrokerCatalog {
  brokers: BrokerCatalogEntry[]
}

export interface AggPosition extends PositionRecord {
  accountId: string
  accountLabel: string
  brokerType: string
  instrumentType?: string
}

export interface AggOrder {
  id: string
  masterOrderId?: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  filledQty: number
  orderType: string
  productType: string
  status: string
  avgPrice?: number
  message?: string
  createdAt: string
  updatedAt: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface AggTrade {
  id: string
  orderId: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  value: number
  chargesTotal: number
  charges: {
    brokerage: number
    stt: number
    transaction: number
    gst: number
    sebi: number
    stamp: number
    total: number
  }
  realizedPnl?: number
  ts: string
  accountId: string
  accountLabel: string
  brokerType: string
}

export interface FundRow {
  accountId: string
  label: string
  brokerType: string
  cash: number
  initialCapital: number
  realizedPnl: number
  chargesPaid: number
  deployed: number
}

export interface SymbolRow {
  id: string
  symbol: string
  name: string
  exchange: string
  instrumentType: string
  expiry?: string | null
  strike?: number | null
  optionType?: string | null
  lotSize: number
  basePrice?: number | null
  mappings: { brokerType: string; brokerSymbol: string; brokerToken: string | null }[]
}

export interface StrategyRow {
  id: string
  name: string
  enabled: boolean
  status: string
  exchange: string
  symbol: string
  direction: string
  productType: string
  orderType: string
  qtyMode: string
  fixedQty: number
  capitalAmount?: number | null
  entryTime: string
  entryWindowMin: number
  exitTime: string
  repeatDays: string
  stopLossPct?: number | null
  targetPct?: number | null
  trailingSlPct?: number | null
  lastRunDate?: string | null
  entryPrice?: number | null
  realizedPnl: number
  logs: { id: string; ts: string; level: string; message: string }[]
}

export interface CopyTradeCfg {
  id: string
  enabled: boolean
  masterAccountId: string | null
  capitalSharePct: number
  slippagePct: number
  roundToLot: boolean
  skipFailedLegs: boolean
  killSwitch: boolean
}

export interface OptionUnderlyingRow {
  underlying: string
  name: string
  lotSize: number
  expiries: string[]
  instrumentType: string
}

export interface ChainMeta {
  underlying: string
  exchange: string
  spot: number
  prevClose: number
  spotLive?: boolean
  atm: number
  ceAtm: number
  peAtm: number
  step: number
  lotSize: number
  expiry: string
  expiries: string[]
  sessionIv?: number | null
  strikesAvailable: number[]
}

export interface OptionGreeks {
  delta: number
  gamma: number
  theta: number
  vega: number
  iv?: number
}

export interface OptionQuoteCell {
  symbol: string
  exists: boolean
  ltp: number
  prevClose: number
  high: number
  low: number
  changePct: number
  greeks?: OptionGreeks | null
}

export interface ChainStrikeRow {
  strike: number
  offset: number
  offsetCe: number
  offsetPe: number
  ce: OptionQuoteCell
  pe: OptionQuoteCell
}

export const ACCOUNT_ID = 'primary'

function acct(): { accountId: string; accountLabel: string; brokerType: string } {
  const id = identity()
  return { accountId: ACCOUNT_ID, accountLabel: id.username, brokerType: id.broker }
}

function mapOrderStatus(s: string): string {
  const t = (s || '').toLowerCase()
  if (t === 'complete' || t === 'filled') return 'FILLED'
  if (t === 'rejected') return 'REJECTED'
  if (t === 'cancelled') return 'CANCELLED'
  if (t.includes('trigger')) return 'SL_PENDING'
  return 'OPEN'
}

// ------------------------------------------------------------
// option chain mapping (OpenAlgo OptionChainResponse → ChainMeta/rows)
// ------------------------------------------------------------

interface OaOptionData {
  symbol?: string
  ltp?: number
  prev_close?: number
  high?: number
  low?: number
  lotsize?: number
  implied_volatility?: number | null
  delta?: number | null
  gamma?: number | null
  theta?: number | null
  vega?: number | null
}
interface OaChainResp {
  status?: string
  underlying?: string
  underlying_symbol?: string
  underlying_exchange?: string
  underlying_ltp?: number
  underlying_prev_close?: number
  expiry_date?: string
  atm_strike?: number
  chain?: { strike: number; ce: OaOptionData | null; pe: OaOptionData | null }[]
  message?: string
}

function cellFrom(d: OaOptionData | null): OptionQuoteCell {
  if (!d || !d.symbol)
    return {
      symbol: '',
      exists: false,
      ltp: 0,
      prevClose: 0,
      high: 0,
      low: 0,
      changePct: 0,
      greeks: null,
    }
  const ltp = num(d.ltp)
  const prevClose = num(d.prev_close)
  const greeks =
    d.delta != null || d.gamma != null || d.theta != null || d.vega != null
      ? {
          delta: num(d.delta),
          gamma: num(d.gamma),
          theta: num(d.theta),
          vega: num(d.vega),
          iv: d.implied_volatility != null ? num(d.implied_volatility) : undefined,
        }
      : null
  return {
    symbol: d.symbol,
    exists: true,
    ltp,
    prevClose,
    high: num(d.high),
    low: num(d.low),
    changePct: prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0,
    greeks,
  }
}

async function oaExpiries(
  underlying: string,
  instrumenttype: 'futures' | 'options'
): Promise<string[]> {
  const exchange = resolveDerivativeExchange(underlying)
  try {
    const r = await oaPost<{ data?: string[] }>(
      '/expiry',
      { symbol: underlying, exchange, instrumenttype },
      0
    )
    return (r.data ?? []).filter(Boolean)
  } catch {
    return []
  }
}

function resolveDerivativeExchange(underlying: string): string {
  const u = underlying.toUpperCase()
  return DERIVATIVE_EXCHANGE[u] ?? (MCX_ROOTS.has(u) ? 'MCX' : CDS_ROOTS.has(u) ? 'CDS' : 'NFO')
}

function expiriesFor(underlying: string, kind: 'futures' | 'options'): string[] | undefined {
  return g.__qdExpCache.get(`${underlying}:${kind}`)
}

async function optionChainImpl(underlying: string, expiry: string | null, _strikes: number[]) {
  const exchange = resolveDerivativeExchange(underlying)
  const r = await oaPost<OaChainResp>(
    '/optionchain',
    {
      underlying,
      exchange,
      expiry_date: expiry ?? '',
      strike_count: 20,
      with_greeks: true,
    },
    0
  )
  const rows = (r.chain ?? []).slice().sort((a, b) => a.strike - b.strike)
  const spot = num(r.underlying_ltp)
  const prevClose = num(r.underlying_prev_close)
  const step = rows.length >= 2 ? Math.max(1, rows[1].strike - rows[0].strike) : 50
  const atm = num(r.atm_strike) || (spot > 0 ? Math.round(spot / step) * step : 0)
  const lotSize = rows.flatMap((x) => [x.ce?.lotsize, x.pe?.lotsize]).find((v) => num(v) > 0)
  const meta: ChainMeta = {
    underlying,
    exchange,
    spot,
    prevClose,
    spotLive: spot > 0,
    atm,
    ceAtm: Math.floor(atm / step) * step,
    peAtm: Math.ceil(atm / step) * step,
    step,
    lotSize: num(lotSize) || getLotSize(underlying) || 1,
    expiry: r.expiry_date ?? expiry ?? '',
    expiries: expiriesFor(underlying, 'options') ?? [],
    strikesAvailable: rows.map((x) => x.strike),
  }
  for (const row of rows) {
    if (row.ce?.symbol) registerLotSize(row.ce.symbol, num(row.ce.lotsize) || meta.lotSize)
    if (row.pe?.symbol) registerLotSize(row.pe.symbol, num(row.pe.lotsize) || meta.lotSize)
  }
  const out = rows.map((x) => ({
    strike: x.strike,
    offset: Math.round((x.strike - atm) / step),
    offsetCe: Math.round((x.strike - meta.ceAtm) / step),
    offsetPe: Math.round((x.strike - meta.peAtm) / step),
    ce: cellFrom(x.ce),
    pe: cellFrom(x.pe),
  }))
  const atmRow = out.find((x) => x.strike === meta.ceAtm) ?? null
  const atmCe = out.find((x) => x.strike === meta.ceAtm)
    ? { ...out.find((x) => x.strike === meta.ceAtm)!.ce, strike: meta.ceAtm }
    : null
  const atmPe = out.find((x) => x.strike === meta.peAtm)
    ? { ...out.find((x) => x.strike === meta.peAtm)!.pe, strike: meta.peAtm }
    : null
  return { meta, rows: out, atmRow, atmCe, atmPe, ts: Date.now() }
}

// ------------------------------------------------------------
// F&O universe (static majors — OpenAlgo has no universe endpoint)
// ------------------------------------------------------------

const FNO_INDICES_NSE = ['NIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']
const FNO_INDICES_BSE = ['SENSEX', 'BANKEX']
const FNO_COMMODITY = ['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM']
const FNO_STOCKS = [
  'RELIANCE',
  'HDFCBANK',
  'ICICIBANK',
  'SBIN',
  'AXISBANK',
  'KOTAKBANK',
  'INFY',
  'TCS',
  'WIPRO',
  'HCLTECH',
  'TECHM',
  'LT',
  'ITC',
  'TATAMOTORS',
  'TATASTEEL',
  'TATAPOWER',
  'TITAN',
  'ASIANPAINT',
  'MARUTI',
  'M&M',
  'BAJFINANCE',
  'BAJAJFINSV',
  'BAJAJ-AUTO',
  'SUNPHARMA',
  'CIPLA',
  'DRREDDY',
  'DIVISLAB',
  'NESTLEIND',
  'HINDUNILVR',
  'BRITANNIA',
  'ULTRACEMCO',
  'GRASIM',
  'SHREECEM',
  'JSWSTEEL',
  'HINDALCO',
  'VEDL',
  'COALINDIA',
  'ONGC',
  'NTPC',
  'POWERGRID',
  'ADANIENT',
  'ADANIPORTS',
  'ADANIGREEN',
  'ADANIPOWER',
  'DMART',
  'TRENT',
  'ZOMATO',
  'NYKAA',
  'POLICYBZR',
  'IRCTC',
  'BEL',
  'HAL',
  'BHEL',
  'DLF',
  'GODREJPROP',
  'PIDILITIND',
  'SIEMENS',
  'ABB',
  'CUMMINSIND',
  'BOSCHLTD',
  'MOTHERSON',
  'BALKRISIND',
  'MRF',
  'APOLLOTYRE',
  'EXIDEIND',
  'LICI',
  'SBILIFE',
  'HDFCLIFE',
  'ICICIGI',
  'ICICIPRULI',
  'PNB',
  'BANKBARODA',
  'CANBK',
  'INDUSINDBK',
  'IDFCFIRSTB',
  'FEDERALBNK',
  'BANDHANBNK',
  'AUBANK',
  'YESBANK',
  'UPI',
  'IDEA',
]

function fnoUniverseImpl(): FnoUniverseResp {
  const mk = (
    underlying: string,
    name: string,
    exchange: string,
    segment: string
  ): FnoUnderlyingRow => ({
    underlying,
    name,
    exchange,
    segment,
    instrumentType: segment === 'IDX' ? 'index' : segment === 'COMM' ? 'commodity' : 'stock',
    lotSize: 0,
    latestExpiry: null,
    contracts: 0,
    spot: 0,
    chgPct: 0,
  })
  return {
    groups: [
      {
        exchange: 'NFO',
        label: 'NSE F&O',
        underlyings: [
          ...FNO_INDICES_NSE.map((s) => mk(s, s, 'NFO', 'IDX')),
          ...FNO_STOCKS.map((s) => mk(s, s, 'NFO', 'EQ')),
        ],
      },
      {
        exchange: 'BFO',
        label: 'BSE F&O',
        underlyings: FNO_INDICES_BSE.map((s) => mk(s, s, 'BFO', 'IDX')),
      },
      {
        exchange: 'MCX',
        label: 'MCX Commodity',
        underlyings: FNO_COMMODITY.map((s) => mk(s, s, 'MCX', 'COMM')),
      },
    ],
  }
}

// ------------------------------------------------------------
// index components (OpenAlgo static profiles + multiquotes)
// ------------------------------------------------------------

async function indexComponentsImpl(symbol: string): Promise<IndexComponentsResp> {
  const profile = constituentsFor(symbol)
  const sym = symbol.toUpperCase()
  const exchange = resolveExchange(sym)
  const idxQuote = await oaPost<{
    data?: { ltp?: number; prev_close?: number; high?: number; low?: number; volume?: number }
  }>('/quotes', { symbol: sym, exchange }, 0)
  const q = idxQuote.data ?? {}
  const idxLtp = num(q.ltp)
  const idxPrev = num(q.prev_close)
  if (!profile) {
    return {
      index: {
        symbol: sym,
        name: sym,
        ltp: idxLtp,
        prevClose: idxPrev,
        high: num(q.high),
        low: num(q.low),
        vol: num(q.volume),
        chgPts: idxLtp - idxPrev,
        chgPct: idxPrev > 0 ? ((idxLtp - idxPrev) / idxPrev) * 100 : 0,
      },
      constituents: [],
      totalPts: idxLtp - idxPrev,
    }
  }
  const list = profile.constituents.map((c) => c.symbol)
  const exch = profile.stockExchange ?? 'NSE'
  const mq = await oaPost<{
    results?: {
      symbol: string
      data?: { ltp?: number; prev_close?: number; high?: number; low?: number; volume?: number }
    }[]
  }>(
    '/multiquotes',
    {
      symbols: list.map((s) => ({ symbol: s, exchange: exch })),
    },
    0
  )
  const bySym = new Map<
    string,
    { ltp?: number; prev_close?: number; high?: number; low?: number; volume?: number }
  >()
  for (const res of mq.results ?? []) bySym.set(res.symbol, res.data ?? {})
  const constituents = profile.constituents.map((c) => {
    const d = bySym.get(c.symbol) ?? {}
    const ltp = num(d.ltp)
    const prev = num(d.prev_close)
    const chgPct = prev > 0 ? ((ltp - prev) / prev) * 100 : 0
    const pts = (chgPct / 100) * c.weight * (idxPrev > 0 ? idxPrev / 100 : 0)
    return {
      symbol: c.symbol,
      weight: c.weight,
      ltp,
      high: num(d.high),
      low: num(d.low),
      vol: num(d.volume),
      chgPct,
      pts,
    }
  })
  const totalPts = constituents.reduce((a, c) => a + c.pts, 0)
  return {
    index: {
      symbol: sym,
      name: profile.label ?? sym,
      ltp: idxLtp,
      prevClose: idxPrev,
      high: num(q.high),
      low: num(q.low),
      vol: num(q.volume),
      chgPts: idxLtp - idxPrev,
      chgPct: idxPrev > 0 ? ((idxLtp - idxPrev) / idxPrev) * 100 : 0,
    },
    constituents,
    totalPts,
  }
}

// ------------------------------------------------------------
// funds cache (session capital + capitalPct sizing)
// ------------------------------------------------------------

async function fundsImpl(): Promise<{ funds: FundRow[] }> {
  const hit = g.__qdFundsCache
  if (hit && Date.now() - hit.ts < 15_000) return { funds: hit.data }
  const a = acct()
  try {
    const r = await oaPost<{
      data?: {
        availablecash?: number
        collateral?: number
        m2mrealized?: number
        m2munrealized?: number
        utiliseddebits?: number
      }
    }>('/funds', {}, 0)
    const d = r.data ?? {}
    const row: FundRow = {
      ...a,
      label: a.accountLabel,
      cash: num(d.availablecash),
      initialCapital: num(d.availablecash),
      realizedPnl: num(d.m2mrealized),
      chargesPaid: 0,
      deployed: num(d.utiliseddebits),
    }
    g.__qdFundsCache = { ts: Date.now(), data: [row] }
    return { funds: [row] }
  } catch {
    return { funds: hit?.data ?? [] }
  }
}

async function lotSizeFor(symbol: string): Promise<number> {
  const cached = getLotSize(symbol)
  if (cached) return cached
  try {
    const rows = await rawSearch(symbol)
    const exact = rows.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase())
    if (exact?.lotsize) {
      registerLotSize(symbol, num(exact.lotsize))
      return num(exact.lotsize)
    }
  } catch {
    /* ignore */
  }
  return 1
}

async function unitsFor(symbol: string, qtyLots: number): Promise<number> {
  const s = symbol.toUpperCase()
  const isDerivative = /(CE|PE|FUT)$/.test(s)
  if (!isDerivative) return Math.max(0, Math.round(qtyLots))
  const lot = await lotSizeFor(symbol)
  return Math.max(0, Math.round(qtyLots * lot))
}

// ------------------------------------------------------------
// order placement
// ------------------------------------------------------------

function failedResult(
  body: { symbol: string; exchange: string; side?: string; qty?: number },
  message: string
): MasterOrderResult {
  const a = acct()
  return {
    masterOrderId: '',
    symbol: body.symbol,
    exchange: body.exchange,
    side: (body.side as OrderSide) ?? 'BUY',
    lots: body.qty ?? 0,
    status: 'FAILED',
    legs: [
      {
        accountId: a.accountId,
        accountLabel: a.accountLabel,
        brokerType: a.brokerType,
        brokerOrderId: null,
        status: 'REJECTED',
        qty: body.qty ?? 0,
        message,
      },
    ],
    message,
  }
}

async function placeOrderImpl(body: Record<string, unknown>): Promise<MasterOrderResult> {
  const a = acct()
  const symbol = String(body.symbol ?? '')
  // derivative contracts always route by their root's derivative exchange —
  // upstream hardcodes NFO at call sites, which would misroute BFO/MCX legs
  const exchange = /(CE|PE|FUT)$/i.test(symbol)
    ? resolveExchange(symbol)
    : String(body.exchange || resolveExchange(symbol))
  registerExchange(symbol, exchange)
  const side = String(body.side ?? 'BUY').toUpperCase()
  const orderType = String(body.orderType ?? 'MARKET').toUpperCase()
  const productType = String(body.productType ?? 'MIS').toUpperCase()
  const limitPrice = num(body.limitPrice) || undefined
  const triggerPrice = num(body.triggerPrice) || undefined
  const strategy = String(body.strategyId || body.tag || 'quantdesk')

  let lots = num(body.qty)
  // capitalPct sizing (strikes panel quick deploy): % of usable capital → lots
  if (lots <= 0 && num(body.capitalPct) > 0) {
    const { funds } = await fundsImpl()
    const usable = funds[0]?.cash ?? 0
    const q = await quoteImpl(symbol).catch(() => null)
    const premium = q?.ltp ?? 0
    const lot = await lotSizeFor(symbol)
    const lotsRaw =
      premium > 0 && lot > 0
        ? Math.floor((usable * num(body.capitalPct)) / 100 / (premium * lot))
        : 0
    if (lotsRaw < 1)
      return failedResult({ symbol, exchange, side, qty: 0 }, 'insufficient capital for 1 lot')
    lots = lotsRaw
  }
  if (lots <= 0) return failedResult({ symbol, exchange, side, qty: 0 }, 'qty is 0')

  const quantity = await unitsFor(symbol, lots)
  if (quantity <= 0)
    return failedResult({ symbol, exchange, side, qty: lots }, 'quantity resolved to 0')

  const r = await oaPost<{ orderid?: string }>('/placeorder', {
    symbol,
    exchange,
    action: side,
    pricetype: orderType,
    product: productType,
    quantity,
    price: limitPrice,
    trigger_price: triggerPrice,
    strategy,
  })
  const leg: OrderLegResult = {
    accountId: a.accountId,
    accountLabel: a.accountLabel,
    brokerType: a.brokerType,
    brokerOrderId: r.orderid ?? null,
    status: r.orderid ? 'FILLED' : 'OPEN',
    qty: quantity,
  }
  return {
    masterOrderId: r.orderid ?? '',
    symbol,
    exchange,
    side: side as OrderSide,
    lots,
    status: 'SUCCESS',
    legs: [leg],
  }
}

async function quoteImpl(symbol: string) {
  const exchange = resolveExchange(symbol)
  const r = await oaPost<{
    data?: {
      ltp?: number
      prev_close?: number
      open?: number
      high?: number
      low?: number
      volume?: number
      bid?: number
      ask?: number
      oi?: number
    } & {
      bids?: { price: number; quantity: number }[]
      asks?: { price: number; quantity: number }[]
    }
  }>('/depth', { symbol, exchange }, 0)
  const d = r.data ?? {}
  return {
    symbol,
    ltp: num(d.ltp),
    prevClose: num(d.prev_close),
    bid: num(d.bid ?? d.bids?.[0]?.price),
    ask: num(d.ask ?? d.asks?.[0]?.price),
    lotSize: getLotSize(symbol),
    instrumentType: null,
    depth: {
      buys: (d.bids ?? []).map((b) => ({ price: num(b.price), qty: num(b.quantity) })),
      sells: (d.asks ?? []).map((b) => ({ price: num(b.price), qty: num(b.quantity) })),
    },
  }
}

// ------------------------------------------------------------
// api — same method surface as upstream quanttrade client-api
// ------------------------------------------------------------

export const api = {
  me: async () => {
    try {
      const r = await fetch('/auth/session-status', { credentials: 'include' })
      const jx = (await r.json()) as {
        authenticated?: boolean
        user?: { username?: string; broker?: string }
      }
      return { user: jx.authenticated ? (jx.user?.username ?? 'trader') : null, feed: 'ok' }
    } catch {
      return { user: null, feed: 'ok' }
    }
  },
  logout: async () => {
    await fetch('/logout', { credentials: 'include' }).catch(() => undefined)
    return { ok: true }
  },

  // OpenAlgo has no per-account tool-plane; the single broker session is the account
  accounts: async () => {
    const { funds } = await fundsImpl().catch(() => ({ funds: [] as FundRow[] }))
    const a = acct()
    const f = funds[0]
    const snap: AccountRow = {
      id: a.accountId,
      label: a.accountLabel,
      brokerType: a.brokerType,
      status: 'connected',
      isActive: true,
      isLiveDataSource: true,
      isOrderEnabled: true,
      isCopyMaster: false,
      usableCapital: f?.cash ?? 0,
      initialCapital: f?.initialCapital ?? 0,
      realizedPnl: f?.realizedPnl ?? 0,
      chargesPaid: 0,
      deployed: f?.deployed ?? 0,
      mode: 'LIVE_BALANCE',
      firstTradeDone: true,
      openPositions: 0,
      openOrders: 0,
      clientId: null,
      modeLabel: 'LIVE',
    }
    return { accounts: [snap] }
  },

  symbols: async (q: string, type?: string) => {
    if (!q.trim()) {
      // watchlist Index-tab universe request: the pinned F&O indices
      if ((type ?? '').toUpperCase().includes('INDEX')) {
        const idx: SymbolRow[] = [...FNO_INDICES_NSE, ...FNO_INDICES_BSE, ...FNO_COMMODITY].map(
          (s2) => ({
            id: `IDX:${s2}`,
            symbol: s2,
            name: s2,
            exchange: resolveExchange(s2),
            instrumentType: MCX_ROOTS.has(s2) ? 'commodity' : 'index',
            expiry: null,
            strike: null,
            optionType: null,
            lotSize: 1,
            basePrice: null,
            mappings: [],
          })
        )
        return { symbols: idx }
      }
      return { symbols: [] as SymbolRow[] }
    }
    const rows = await rawSearch(q.trim()).catch(() => [] as SearchApiRow[])
    // prefer cash + F&O underlyings first, derivatives after
    const sorted = [...rows].sort((x, y) => {
      const px = /(CE|PE|FUT)$/.test(x.symbol) ? 1 : 0
      const py = /(CE|PE|FUT)$/.test(y.symbol) ? 1 : 0
      return px - py
    })
    return { symbols: sorted.slice(0, 120).map(rowToSymbolRow) }
  },
  symbolsByList: async (list: string[]) => {
    if (!list.length) return { symbols: [] as SymbolRow[] }
    const out: SymbolRow[] = []
    await Promise.all(
      list.map(async (s) => {
        try {
          const rows = await rawSearch(s)
          const exact = rows.find((r) => r.symbol.toUpperCase() === s.toUpperCase()) ?? rows[0]
          if (exact) out.push(rowToSymbolRow(exact))
        } catch {
          /* skip */
        }
      })
    )
    return { symbols: out }
  },
  search: async (q: string, exchange?: string): Promise<SearchRowQt[]> => {
    const rows = await rawSearch(q, exchange).catch(() => [] as SearchApiRow[])
    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange,
      expiry: r.expiry ?? null,
      strike: r.strike != null ? num(r.strike) : null,
      lotSize: num(r.lotsize) || 1,
      instrumentType: r.instrumenttype ?? '',
      optionType: r.optiontype ?? null,
    }))
  },
  expiries: async (underlying: string, instrumenttype: 'futures' | 'options' = 'options') => {
    const list = await oaExpiries(underlying, instrumenttype)
    g.__qdExpCache.set(`${underlying}:${instrumenttype}`, list)
    return list
  },
  futuresFor: async (underlying: string, expiry: string | null) => {
    const exchange = resolveDerivativeExchange(underlying)
    const rows = await rawSearch(underlying, exchange).catch(() => [] as SearchApiRow[])
    const futs = rows.filter((r) => /FUT$/i.test(r.symbol))
    if (expiry) {
      const norm = (s?: string | null) => (s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()
      const want = norm(expiry)
      const hit = futs.find((r) => norm(r.expiry) === want)
      if (hit) return rowToSymbolRow(hit)
    }
    return futs.length ? rowToSymbolRow(futs[0]) : null
  },

  placeOrder: placeOrderImpl,
  squareOffAll: async (kill = false, _symbols?: string[]) => {
    let cancelled = 0
    if (kill) {
      try {
        await oaPost('/cancelallorder', {})
        cancelled = 1
      } catch {
        /* none */
      }
    }
    const r = await oaPost<{ message?: string }>('/closeallposition', {})
    return { ok: true, orders: cancelled, filledLegs: 0, message: r.message }
  },
  cancelAll: async (symbols?: string[]) => {
    if (symbols?.length) {
      const { orders } = await api.orders().catch(() => ({ orders: [] as AggOrder[] }))
      const open = orders.filter((o) => o.status === 'OPEN' && symbols.includes(o.symbol))
      let n = 0
      for (const o of open) {
        try {
          await api.cancelOrder(o.accountId, o.id)
          n++
        } catch {
          /* skip */
        }
      }
      return { ok: true, cancelled: n }
    }
    await oaPost('/cancelallorder', {})
    return { ok: true, cancelled: 1 }
  },
  orders: async () => {
    const r = await oaPost<{
      data?: {
        orders?: {
          orderid: string
          symbol: string
          exchange: string
          action: string
          quantity: number
          price: number
          trigger_price: number
          pricetype: string
          product: string
          order_status: string
          timestamp: string
        }[]
      }
    }>('/orderbook', {}, 0)
    const a = acct()
    const orders = (r.data?.orders ?? []).map((o) => ({
      id: o.orderid,
      masterOrderId: o.orderid,
      symbol: o.symbol,
      exchange: o.exchange,
      side: (o.action ?? 'BUY').toUpperCase() as 'BUY' | 'SELL',
      qty: num(o.quantity),
      filledQty: mapOrderStatus(o.order_status) === 'FILLED' ? num(o.quantity) : 0,
      orderType: o.pricetype,
      productType: o.product,
      status: mapOrderStatus(o.order_status),
      avgPrice: num(o.price) || undefined,
      message: undefined,
      createdAt: o.timestamp,
      updatedAt: o.timestamp,
      ...a,
    }))
    return { orders }
  },
  positions: async () => {
    const r = await oaPost<{
      data?: {
        positions?: {
          symbol: string
          exchange: string
          product: string
          quantity: number
          average_price: number
          ltp: number
          pnl: number
          pnlpercent: number
        }[]
      }
    }>('/positionbook', {}, 0)
    const a = acct()
    const positions: AggPosition[] = (r.data?.positions ?? []).map((p) => {
      const netQty = num(p.quantity)
      const ltp = num(p.ltp)
      return {
        symbol: p.symbol,
        exchange: p.exchange,
        productType: (p.product ?? 'MIS') as AggPosition['productType'],
        netQty,
        buyQty: netQty > 0 ? netQty : 0,
        sellQty: netQty < 0 ? -netQty : 0,
        avgPrice: num(p.average_price),
        realizedPnl: 0,
        ltp,
        unrealizedPnl: num(p.pnl),
        lotSize: getLotSize(p.symbol) ?? 1,
        updatedAt: new Date().toISOString(),
        ...a,
      }
    })
    const bySymbol = new Map<
      string,
      {
        symbol: string
        netQty: number
        avgPrice: number
        ltp: number
        unrealizedPnl: number
        accounts: number
      }
    >()
    for (const p of positions) {
      const cur = bySymbol.get(p.symbol)
      if (cur) {
        cur.netQty += p.netQty
        cur.unrealizedPnl += p.unrealizedPnl
      } else
        bySymbol.set(p.symbol, {
          symbol: p.symbol,
          netQty: p.netQty,
          avgPrice: p.avgPrice,
          ltp: p.ltp,
          unrealizedPnl: p.unrealizedPnl,
          accounts: 1,
        })
    }
    const totals = {
      unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
      realizedPnl: positions.reduce((s, p) => s + p.realizedPnl, 0),
      openPositions: positions.filter((p) => p.netQty !== 0).length,
    }
    return { positions, bySymbol: [...bySymbol.values()], totals }
  },
  trades: async () => {
    const r = await oaPost<{
      data?: {
        trades?: {
          orderid: string
          symbol: string
          exchange: string
          action: string
          quantity: number
          average_price: number
          trade_value: number
          product: string
          timestamp: string
        }[]
      }
    }>('/tradebook', {}, 0)
    const a = acct()
    const zero = { brokerage: 0, stt: 0, transaction: 0, gst: 0, sebi: 0, stamp: 0, total: 0 }
    const trades = (r.data?.trades ?? []).map((t, i) => ({
      id: `${t.orderid}:${i}`,
      orderId: t.orderid,
      symbol: t.symbol,
      exchange: t.exchange,
      side: (t.action ?? 'BUY').toUpperCase() as 'BUY' | 'SELL',
      qty: num(t.quantity),
      price: num(t.average_price),
      value: num(t.trade_value),
      chargesTotal: 0,
      charges: zero,
      ts: t.timestamp,
      ...a,
    }))
    return { trades, totals: { charges: 0, realized: 0 } }
  },
  funds: fundsImpl,
  syncFunds: async () => {
    g.__qdFundsCache = null
    return { ok: true }
  },
  cancelOrder: async (_accountId: string, orderId: string) => {
    await oaPost('/cancelorder', { orderid: orderId })
    return { ok: true }
  },
  sessionStats: async () => {
    const [pos, trd, fnd] = await Promise.all([
      api.positions().catch(() => null),
      api.trades().catch(() => null),
      fundsImpl().catch(() => ({ funds: [] as FundRow[] })),
    ])
    const a = acct()
    const unrealized = pos?.totals.unrealizedPnl ?? 0
    const realized = fnd.funds[0]?.realizedPnl ?? 0
    const trades = trd?.trades ?? []
    const bySym = new Map<string, number>()
    for (const t of trades)
      bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + (t.side === 'SELL' ? t.value - 0 : 0))
    return {
      winRate: null,
      pts: 0,
      realized,
      unrealized,
      net: realized + unrealized,
      closes: trades.length,
      wins: 0,
      trades: trades.length,
      charges: 0,
      perAccount: [
        {
          ...a,
          label: a.accountLabel,
          trades: trades.length,
          closes: trades.length,
          wins: 0,
          pts: 0,
          realized,
          unrealized,
          charges: 0,
        },
      ],
      topSymbols: [...bySym.entries()]
        .map(([symbol, pts]) => ({ symbol, pts }))
        .sort((x, y) => y.pts - x.pts)
        .slice(0, 5),
    } as unknown as SessionStatsResp
  },

  candles: async (
    symbol: string,
    tf: Timeframe,
    limit = 3000,
    days = 3,
    end?: number
  ): Promise<{ candles: Candle[] }> => {
    const exchange = resolveExchange(symbol)
    const INTERVAL: Record<Timeframe, string> = {
      '1m': '1m',
      '3m': '3m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
      '1d': 'D',
    }
    const endMs = end ?? Date.now()
    const startMs = endMs - Math.max(1, days) * 86_400_000
    const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const r = await oaPost<{
      data?: {
        timestamp?: number
        time?: number
        open: number
        high: number
        low: number
        close: number
        volume?: number
      }[]
    }>(
      '/history',
      {
        symbol,
        exchange,
        interval: INTERVAL[tf] ?? tf,
        start_date: utcDate(startMs),
        end_date: utcDate(endMs),
      },
      1
    )
    const candles: Candle[] = []
    for (const row of r.data ?? []) {
      const raw = row.timestamp ?? row.time
      const ms = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : NaN
      if (!Number.isFinite(ms)) continue
      candles.push({
        t: ms,
        o: num(row.open),
        h: num(row.high),
        l: num(row.low),
        c: num(row.close),
        v: num(row.volume),
      })
    }
    candles.sort((a, b) => a.t - b.t)
    if (end) while (candles.length && candles[candles.length - 1].t > end) candles.pop()
    return { candles: candles.slice(-limit) }
  },
  quote: quoteImpl,
  indexComponents: indexComponentsImpl,
  status: async () => ({
    services: {},
    masterContracts: { count: 0, lastSync: null },
    accounts: 1,
    enabledStrategies: 0,
  }),

  fnoUniverse: async () => fnoUniverseImpl(),
  optionUnderlyings: async () => {
    const uni = fnoUniverseImpl()
    const underlyings: OptionUnderlyingRow[] = []
    for (const g2 of uni.groups) {
      for (const u of g2.underlyings) {
        underlyings.push({
          underlying: u.underlying,
          name: u.name,
          lotSize: u.lotSize || 1,
          expiries: [],
          instrumentType: u.instrumentType,
        })
      }
    }
    return { underlyings }
  },
  optionChain: optionChainImpl,
  ensureStrike: async (underlying: string, strike: number, expiry: string | null) => {
    const exchange = resolveDerivativeExchange(underlying)
    const symbols: string[] = []
    for (const ot of ['CE', 'PE']) {
      try {
        const r = await oaPost<{ symbol?: string }>(
          '/optionsymbol',
          {
            underlying,
            exchange,
            expiry_date: expiry ?? '',
            strike_price: strike,
            option_type: ot,
          },
          0
        )
        if (r.symbol) {
          symbols.push(r.symbol)
          registerExchange(r.symbol, exchange)
        }
      } catch {
        /* skip */
      }
    }
    return { ok: true, created: 0, symbols }
  },

  // surfaces the ported UI doesn't reach in OpenAlgo — harmless empty answers
  strategies: async () => ({ strategies: [] as StrategyRow[] }),
  createStrategy: async () => ({ ok: false }),
  patchStrategy: async () => ({ ok: false }),
  deleteStrategy: async () => ({ ok: false }),
  strategyPython: async () => ({ code: '', filename: null }),
  gttRules: async () => ({ rules: [] as GttRuleRow[] }),
  createGtt: async () => ({ ok: false, rule: null as unknown as GttRuleRow }),
  patchGtt: async () => ({ ok: false, rule: null as unknown as GttRuleRow }),
  deleteGtt: async () => ({ ok: false }),
  brokerLogs: async () => ({
    logs: [] as { id: number; ts: string; level: string; message: string }[],
  }),
  audit: async () => ({ audits: [] as never[] }),
  autoRules: async () => ({ rules: [] as AutoRuleRow[] }),
  createAutoRule: async () => ({ ok: false, rule: null as unknown as AutoRuleRow }),
  patchAutoRule: async () => ({ ok: false }),
  deleteAutoRule: async () => ({ ok: false }),
  marginCalc: async () => ({ ok: false, margin: 0 }) as MarginResp,
  brokerOrderBook: async () => ({
    orders: [] as BrokerBookRow[],
    live: false,
    message: 'single OpenAlgo session',
  }),
  portfolio: async () =>
    ({
      holdings: [],
      accounts: [],
      totals: { value: 0, invested: 0, pnl: 0 },
    }) as unknown as PortfolioResp,
  feedSource: async () => ({
    source: 'openalgo',
    sources: [
      { id: 'openalgo', label: 'OpenAlgo feed', brokerType: identity().broker, hasSession: true },
    ],
  }),
  setFeedSource: async () => ({ ok: true, source: 'openalgo' }),
  feedStatus: async () =>
    ({
      connected: true,
      fresh: true,
      source: 'openalgo',
      lastTickTs: Date.now(),
      lastError: null,
      errorTs: null,
      symbols: 0,
      polls: 0,
      errors: 0,
      startedAt: Date.now(),
      log: [],
      sessionPresent: true,
      sourceIsLive: true,
    }) as unknown as FeedStatusResp,
}

export interface GttRuleRow {
  id: string
  name: string
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  qty: number
  trigger: 'ABOVE' | 'BELOW'
  triggerPrice: number
  orderType: 'LIMIT' | 'MARKET'
  productType: string
  repeatDaily: boolean
  armed: boolean
  lastTriggeredAt?: string
  lastStatus?: string
  lastMessage?: string
  createdAt: string
}
export interface AutoRuleRow {
  id: string
  name: string
  underlying: string
  expiry: string | null
  kind: 'INDEX' | 'INDEX_RANGE' | 'TIME' | 'COMPOUND'
  level?: number
  cross?: 'ABOVE' | 'BELOW'
  lo?: number
  hi?: number
  time?: string
  entryOp?: 'LTE' | 'GTE' | 'RANGE'
  entryLo?: number
  entryHi?: number
  action: 'BUY' | 'SELL' | 'DEPLOY' | 'CANCEL'
  optType: 'CE' | 'PE'
  offset: number
  strikes?: { strike: number; type: 'CE' | 'PE'; allocPct: number }[]
  allocPct: number
  entryPrice?: number
  stopLoss?: number
  target?: number
  enabled: boolean
  repeatDaily: boolean
  lastFiredDate?: string
  lastFiredAt?: string
  lastStatus?: string
  lastMessage?: string
  fireCount: number
  createdAt: string
}
export interface MarginResp {
  ok: boolean
  margin: number
  message?: string
}
export interface BrokerBookRow {
  brokerOrderId: string
  symbol: string
  side: string
  qty: number
  filledQty?: number
  status: string
  avgPrice?: number
  orderType?: string
  ts?: string
}
export interface PortfolioResp {
  holdings: unknown[]
  accounts: unknown[]
  totals: { value: number; invested: number; pnl: number }
}
export interface FeedStatusResp {
  connected: boolean
  fresh: boolean
  source: string
  lastTickTs: number | null
  lastError: string | null
  errorTs: number | null
  symbols: number
  polls: number
  errors: number
  startedAt: number
  log: string[]
  sessionPresent: boolean
  sourceIsLive: boolean
}
export interface IndexComponentRow {
  symbol: string
  weight: number
  ltp: number
  high: number
  low: number
  vol: number
  chgPct: number
  pts: number
}
export interface IndexComponentsResp {
  index: {
    symbol: string
    name: string
    ltp: number
    prevClose: number
    high: number
    low: number
    vol: number
    chgPts: number
    chgPct: number
  }
  constituents: IndexComponentRow[]
  totalPts: number
}
export interface SessionStatsResp {
  winRate: number | null
  pts: number
  realized: number
  unrealized: number
  unrealizedNet?: number
  net: number
  pocket?: number
  closes: number
  wins: number
  trades: number
  charges: number
  perAccount: {
    accountId: string
    label: string
    brokerType: string
    trades: number
    closes: number
    wins: number
    pts: number
    realized: number
    unrealized: number
    charges: number
    pocket?: number
  }[]
  topSymbols: { symbol: string; pts: number }[]
}
export interface FnoUnderlyingRow {
  underlying: string
  name: string
  exchange: string
  segment: string
  instrumentType: string
  lotSize: number
  latestExpiry: string | null
  contracts: number
  spot: number
  chgPct: number
}
export interface FnoUniverseResp {
  groups: { exchange: string; label: string; underlyings: FnoUnderlyingRow[] }[]
}

// ---- ITM / OTM / ATM strike labeling (hedge-desk convention) ----
// Side-ATM: CE ATM = floor(spot/step)*step, PE ATM = ceil(spot/step)*step.
// offset = steps vs the SIDE's ATM (offsetCe for CE, offsetPe for PE):
//   CE: negative offset = strike below side-ATM = ITM, positive = OTM
//   PE: positive offset = strike above side-ATM = ITM, negative = OTM
export function sideOffsetLabel(offset: number | null | undefined, type: 'CE' | 'PE'): string {
  if (offset == null || !Number.isFinite(offset)) return ''
  if (offset === 0) return 'ATM'
  const itm = type === 'CE' ? offset < 0 : offset > 0
  return `${itm ? 'ITM' : 'OTM'} ${Math.abs(offset)}`
}

/** Side-specific strike for a labeled distance from ATM: dir = -1 (ITM) | 0 (ATM) | +1 (OTM). */
export function sideStrikeFor(
  atm: { ce: number; pe: number },
  step: number,
  dir: -1 | 0 | 1,
  n: number,
  type: 'CE' | 'PE'
): number {
  const base = type === 'CE' ? atm.ce : atm.pe
  const signed = type === 'CE' ? dir : -dir
  return base + signed * n * step
}

export function fmtMoney(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtInr(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  const sign = n < 0 ? '-' : ''
  return (
    sign +
    '₹' +
    Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
  )
}

export function fmtTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false })
}

export function fmtDateTime(ts: string | number | Date): string {
  return new Date(ts).toLocaleString('en-IN', {
    hour12: false,
    dateStyle: 'short',
    timeStyle: 'medium',
  })
}
