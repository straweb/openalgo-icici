// ============================================================
// Sync-hub adapter for the vendored quanttrade terminal.
//
// Upstream pushed accounts / positions / orders / trades / funds /
// session stats / option chains over socket.io channels. OpenAlgo
// exposes those as REST endpoints, so this adapter keeps the exact
// hook surface (useSyncChannel / useSyncData / syncSubscribe /
// mergeChain + SyncCore / SyncChainResp) and produces the same
// payloads with polite polling — order/position/trade books every
// 4s while a consumer is attached, funds every 30s, chains every 6s.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { ChainMeta, ChainStrikeRow, OptionQuoteCell } from './client-api'
import { api } from './client-api'

export interface SyncSubParams {
  chains?: { underlying: string; expiry?: string | null }[]
  index?: string[]
}

type SyncHandler = (data: unknown) => void

const g = globalThis as unknown as {
  __syncHandlers: Map<string, Set<SyncHandler>>
  __syncSubs: SyncSubParams
  __syncTimers: {
    core?: ReturnType<typeof setInterval>
    chain?: ReturnType<typeof setInterval>
    busy: boolean
    fundsAt: number
  }
}
if (!g.__syncHandlers) g.__syncHandlers = new Map()
if (!g.__syncSubs) g.__syncSubs = {}
if (!g.__syncTimers) g.__syncTimers = { busy: false, fundsAt: 0 }

function emitLocal(channel: string, data: unknown) {
  const set = g.__syncHandlers.get(channel)
  if (set)
    for (const fn of set) {
      try {
        fn(data)
      } catch {
        /* ignore */
      }
    }
}

function listenerCount(channel: string): number {
  return g.__syncHandlers.get(channel)?.size ?? 0
}

// ---- sync:core poller ------------------------------------------------

const CORE_MS = 4_000
const FUNDS_MS = 30_000

async function pollCore() {
  const t = g.__syncTimers
  if (t.busy || document.hidden) return
  t.busy = true
  try {
    const wantFunds = Date.now() - t.fundsAt > FUNDS_MS
    const [orders, positions, trades, funds] = await Promise.all([
      api.orders().catch(() => null),
      api.positions().catch(() => null),
      wantFunds ? null : api.trades().catch(() => null),
      wantFunds ? api.funds().catch(() => null) : null,
    ])
    if (wantFunds) t.fundsAt = Date.now()
    const tradesResp = trades ?? (await api.trades().catch(() => null))
    const acct = { accountId: 'primary', accountLabel: 'session', brokerType: 'openalgo' }
    const fundRows = funds?.funds ?? []
    const unrealized = positions?.totals?.unrealizedPnl ?? 0
    const realized = fundRows[0]?.realizedPnl ?? 0
    const tradesList = tradesResp?.trades ?? []
    const core: SyncCore = {
      accounts:
        (await api.accounts().catch(() => null))?.accounts?.map((a) => ({
          id: a.id,
          label: a.label,
          brokerType: a.brokerType,
          status: a.status,
          isActive: a.isActive,
          isLiveDataSource: a.isLiveDataSource,
          isOrderEnabled: a.isOrderEnabled,
          isCopyMaster: a.isCopyMaster,
          clientId: a.clientId,
          usableCapital: a.usableCapital,
          initialCapital: a.initialCapital,
          realizedPnl: a.realizedPnl,
          capitalBase: 'FIXED',
          capitalPct: 0,
          availableCash: a.usableCapital,
          chargesPaid: a.chargesPaid,
          deployed: a.deployed,
          mode: a.mode,
          modeLabel: a.modeLabel ?? 'LIVE',
          netPnl: a.netPnl,
          openNet: a.openNet,
          pocket: a.pocket,
          firstTradeDone: a.firstTradeDone,
          openPositions: positions?.totals?.openPositions ?? 0,
          openOrders: (orders?.orders ?? []).filter((o) => o.status === 'OPEN').length,
        })) ?? [],
      positions: (positions?.positions ?? []).map((p) => ({
        accountId: p.accountId,
        accountLabel: p.accountLabel,
        brokerType: p.brokerType,
        symbol: p.symbol,
        exchange: p.exchange,
        productType: p.productType,
        netQty: p.netQty,
        buyQty: p.buyQty,
        sellQty: p.sellQty,
        avgPrice: p.avgPrice,
        realizedPnl: p.realizedPnl,
        ltp: p.ltp,
        unrealizedPnl: p.unrealizedPnl,
        lotSize: p.lotSize,
        updatedAt: p.updatedAt,
      })),
      orders: (orders?.orders ?? []).map((o) => ({
        id: o.id,
        masterOrderId: o.masterOrderId,
        symbol: o.symbol,
        exchange: o.exchange,
        side: o.side,
        qty: o.qty,
        filledQty: o.filledQty,
        orderType: o.orderType,
        productType: o.productType,
        status: o.status,
        avgPrice: o.avgPrice,
        message: o.message,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        accountId: o.accountId,
        accountLabel: o.accountLabel,
        brokerType: o.brokerType,
      })),
      trades: tradesList.map((t) => ({
        id: t.id,
        orderId: t.orderId,
        symbol: t.symbol,
        exchange: t.exchange,
        side: t.side,
        qty: t.qty,
        price: t.price,
        value: t.value,
        chargesTotal: t.chargesTotal,
        charges: t.charges,
        ts: t.ts,
        accountId: t.accountId,
        accountLabel: t.accountLabel,
        brokerType: t.brokerType,
      })),
      funds: fundRows.map((f) => ({
        accountId: f.accountId,
        label: f.label,
        brokerType: f.brokerType,
        cash: f.cash,
        initialCapital: f.initialCapital,
        realizedPnl: f.realizedPnl,
        chargesPaid: f.chargesPaid,
        deployed: f.deployed,
      })),
      session: {
        winRate: null,
        pts: 0,
        realized,
        unrealized,
        net: realized + unrealized,
        closes: tradesList.length,
        wins: 0,
        trades: tradesList.length,
        charges: 0,
        perAccount: [
          {
            ...acct,
            label: acct.accountLabel,
            trades: tradesList.length,
            closes: tradesList.length,
            wins: 0,
            pts: 0,
            realized,
            unrealized,
            charges: 0,
          },
        ],
        topSymbols: [],
      },
      sessionStart: new Date().toISOString(),
      ts: Date.now(),
    }
    void acct
    emitLocal('sync:core', core)
  } catch {
    /* keep last payload */
  } finally {
    t.busy = false
  }
}

// ---- sync:chain poller -----------------------------------------------

const CHAIN_MS = 6_000
const chainBusy = new Set<string>()

async function pollChain() {
  if (document.hidden) return
  const chains = g.__syncSubs.chains ?? []
  for (const c of chains) {
    const key = `${c.underlying}:${c.expiry ?? ''}`
    if (chainBusy.has(key)) continue
    chainBusy.add(key)
    void api
      .optionChain(c.underlying, c.expiry ?? null, [])
      .then((resp) => {
        emitLocal('sync:chain', {
          meta: resp.meta,
          rows: resp.rows,
          atmCe: resp.atmCe ?? null,
          atmPe: resp.atmPe ?? null,
          ts: Date.now(),
        })
      })
      .catch(() => {
        /* keep last */
      })
      .finally(() => {
        chainBusy.delete(key)
      })
  }
}

// ---- sync:index poller ------------------------------------------------

const indexBusy = new Set<string>()

async function pollIndex() {
  if (document.hidden) return
  for (const sym of g.__syncSubs.index ?? []) {
    if (indexBusy.has(sym)) continue
    indexBusy.add(sym)
    void api
      .indexComponents(sym)
      .then((resp) => emitLocal('sync:index', resp))
      .catch(() => {
        /* keep last */
      })
      .finally(() => {
        indexBusy.delete(sym)
      })
  }
}

function ensurePollers() {
  const t = g.__syncTimers
  if (!t.core && listenerCount('sync:core') > 0) {
    t.core = setInterval(() => {
      void pollCore()
    }, CORE_MS)
    void pollCore()
  }
  const wantsChain = listenerCount('sync:chain') > 0 && (g.__syncSubs.chains ?? []).length > 0
  if (!t.chain && wantsChain) {
    t.chain = setInterval(() => {
      void pollChain()
      if (listenerCount('sync:index') > 0) void pollIndex()
    }, CHAIN_MS)
    void pollChain()
    if (listenerCount('sync:index') > 0) void pollIndex()
  }
}

function maybeStopPollers() {
  const t = g.__syncTimers
  if (t.core && listenerCount('sync:core') === 0) {
    clearInterval(t.core)
    t.core = undefined
  }
  const wantsChain = listenerCount('sync:chain') > 0 && (g.__syncSubs.chains ?? []).length > 0
  if (t.chain && !wantsChain) {
    clearInterval(t.chain)
    t.chain = undefined
  }
}

/** Register per-session sync parameters (chains / index lists). */
export function syncSubscribe(params: SyncSubParams) {
  g.__syncSubs = params
  ensurePollers()
  void pollChain()
}

/** Attach a listener to a sync channel. Returns an unsubscribe fn. */
export function onSync<T>(channel: string, fn: (data: T) => void): () => void {
  if (!g.__syncHandlers.has(channel)) g.__syncHandlers.set(channel, new Set())
  const wrapped = fn as SyncHandler
  g.__syncHandlers.get(channel)!.add(wrapped)
  ensurePollers()
  return () => {
    g.__syncHandlers.get(channel)?.delete(wrapped)
    maybeStopPollers()
  }
}

/** React hook: subscribe to a sync channel (always-on). */
export function useSyncChannel<T>(channel: string): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => onSync<T>(channel, setData), [channel])
  return data
}

/** React hook: subscribe to a sync channel whose payload only arrives
 *  when the given params are subscribed. Merges all chain/index params
 *  from every consumer of the hook set — each hook instance only keeps
 *  its own payload slice. */
export function useSyncData<T>(
  channel: 'sync:core' | 'sync:chain' | 'sync:index',
  match?: (data: T) => boolean,
  params?: SyncSubParams
): T | null {
  const [data, setData] = useState<T | null>(null)
  const matchRef = useRef(match)
  matchRef.current = match
  const paramsKey = JSON.stringify(params ?? {})
  useEffect(() => {
    if (params) {
      const cur = g.__syncSubs
      const chains = [...(cur.chains ?? [])]
      for (const c of params.chains ?? []) {
        if (
          !chains.some(
            (x) => x.underlying === c.underlying && (x.expiry ?? null) === (c.expiry ?? null)
          )
        )
          chains.push({ underlying: c.underlying, expiry: c.expiry ?? null })
      }
      const index = [...(cur.index ?? [])]
      for (const i of params.index ?? []) if (!index.includes(i)) index.push(i)
      syncSubscribe({ chains, index })
    }
    return onSync<T>(channel, (d) => {
      if (!matchRef.current || matchRef.current(d)) setData(d)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, paramsKey])
  return data
}

/** Global sync:core payload shape (mirrors the REST aggregates). */
export interface SyncCore {
  accounts: {
    id: string
    label: string
    brokerType: string
    status: string
    isActive: boolean
    isLiveDataSource: boolean
    isOrderEnabled: boolean
    isCopyMaster: boolean
    clientId: string | null
    usableCapital: number
    initialCapital: number
    realizedPnl: number
    capitalBase: string
    capitalPct: number
    availableCash: number | null
    chargesPaid: number
    deployed: number
    mode: string
    modeLabel: string
    netPnl?: number
    openNet?: number
    pocket?: number
    firstTradeDone: boolean
    openPositions: number
    openOrders: number
  }[]
  positions: {
    accountId: string
    accountLabel: string
    brokerType: string
    symbol: string
    exchange: string
    productType: string
    netQty: number
    buyQty: number
    sellQty: number
    avgPrice: number
    realizedPnl: number
    ltp: number
    unrealizedPnl: number
    netIfExit?: number
    exitCharges?: number
    lotSize: number
    updatedAt: string
  }[]
  orders: {
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
  }[]
  trades: {
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
    } | null
    realizedPnl?: number
    ts: string
    accountId: string
    accountLabel: string
    brokerType: string
  }[]
  funds: {
    accountId: string
    label: string
    brokerType: string
    cash: number
    initialCapital: number
    realizedPnl: number
    chargesPaid: number
    deployed: number
    netPnl?: number
    openNet?: number
    pocket?: number
  }[]
  session: {
    winRate: number | null
    pts: number
    realized: number
    unrealized: number
    net: number
    unrealizedNet?: number
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
  sessionStart: string
  ts: number
}

// ---- option chain over the sync hub ----

export interface SyncChainResp {
  meta: ChainMeta
  rows: ChainStrikeRow[]
  atmCe: (OptionQuoteCell & { strike: number }) | null
  atmPe: (OptionQuoteCell & { strike: number }) | null
  ts: number
}

type ChainRespLike = {
  meta: ChainMeta
  rows: ChainStrikeRow[]
  atmCe?: (OptionQuoteCell & { strike: number }) | null
  atmPe?: (OptionQuoteCell & { strike: number }) | null
  ts?: number
}

/** Merge the realtime chain payload with a REST fetch: the polled copy
 *  wins per strike, REST rows fill strikes outside the polled band. */
export function mergeChain(
  sync: ChainRespLike | null | undefined,
  rest: ChainRespLike | null | undefined
): SyncChainResp | null {
  if (!sync)
    return rest
      ? {
          meta: rest.meta,
          rows: rest.rows,
          atmCe: rest.atmCe ?? null,
          atmPe: rest.atmPe ?? null,
          ts: rest.ts ?? 0,
        }
      : null
  if (!rest)
    return {
      meta: sync.meta,
      rows: sync.rows,
      atmCe: sync.atmCe ?? null,
      atmPe: sync.atmPe ?? null,
      ts: sync.ts ?? 0,
    }
  const map = new Map<number, ChainStrikeRow>()
  for (const r of rest.rows) map.set(r.strike, r)
  for (const r of sync.rows) map.set(r.strike, r)
  return {
    meta: sync.meta,
    rows: [...map.values()].sort((a, b) => a.strike - b.strike),
    atmCe: sync.atmCe ?? rest.atmCe ?? null,
    atmPe: sync.atmPe ?? rest.atmPe ?? null,
    ts: sync.ts ?? 0,
  }
}
