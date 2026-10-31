// ============================================================
// OpenAlgo market-feed adapter for the vendored quanttrade terminal.
//
// Upstream used socket.io against the quanttrade hub. OpenAlgo runs a
// raw WebSocket proxy (`/api/websocket/config` → WEBSOCKET_URL, default
// ws://127.0.0.1:8765) with `authenticate` / `subscribe` actions and
// `market_data` events. This module keeps the upstream export surface
// — ensureSocket / onTicks / onFeedStatus / subscribeTicks /
// unsubscribeTicks — so the ported panels compile unchanged.
// ============================================================

import { resolveExchange } from './client-api'
import type { Tick } from './types'

type TickListener = (ticks: Record<string, Tick>) => void
type StatusListener = (up: boolean) => void

interface FeedState {
  ws: WebSocket | null
  apiKey: string
  wsUrl: string
  up: boolean
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
  ping: ReturnType<typeof setInterval> | null
  wanted: Map<string, number> // symbol → refcount
  sent: Set<string>
  pending: Set<string>
  tickListeners: Set<TickListener>
  statusListeners: Set<StatusListener>
  lastTick: Map<string, Tick>
  lastSweep: number
}

const g = globalThis as unknown as { __qdFeed?: FeedState }
function state(): FeedState {
  if (!g.__qdFeed) {
    g.__qdFeed = {
      ws: null,
      apiKey: '',
      wsUrl: '',
      up: false,
      attempts: 0,
      timer: null,
      ping: null,
      wanted: new Map(),
      sent: new Set(),
      pending: new Set(),
      tickListeners: new Set(),
      statusListeners: new Set(),
      lastTick: new Map(),
      lastSweep: 0,
    }
  }
  return g.__qdFeed
}

/** The page injects the OpenAlgo session credentials before first connect. */
export function setFeedCredentials(wsUrl: string, apiKey: string) {
  const s = state()
  s.wsUrl = wsUrl
  s.apiKey = apiKey
}

function emitStatus(up: boolean) {
  const s = state()
  if (s.up === up) return
  s.up = up
  for (const fn of s.statusListeners) {
    try {
      fn(up)
    } catch {
      /* ignore */
    }
  }
}

function fanout() {
  const s = state()
  if (!s.tickListeners.size) return
  const snap: Record<string, Tick> = {}
  for (const [sym, t] of s.lastTick) snap[sym] = t
  for (const fn of s.tickListeners) {
    try {
      fn(snap)
    } catch {
      /* ignore */
    }
  }
}

function handleMessage(ev: MessageEvent) {
  const s = state()
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(String(ev.data)) as Record<string, unknown>
  } catch {
    return
  }
  const type = msg.type as string | undefined
  if (type === 'market_data') {
    const symbol = String(msg.symbol ?? '')
    const d = (msg.data ?? {}) as Record<string, unknown>
    const n = (v: unknown) => {
      const x = typeof v === 'number' ? v : parseFloat(String(v ?? 0))
      return Number.isFinite(x) ? x : 0
    }
    const depth = d.depth as { buy?: { price?: number }[]; sell?: { price?: number }[] } | undefined
    const tick: Tick = {
      symbol,
      ltp: n(d.ltp),
      prevClose: n(d.close),
      open: n(d.open),
      high: n(d.high),
      low: n(d.low),
      vol: n(d.volume),
      bid: n(d.bid ?? depth?.buy?.[0]?.price) || undefined,
      ask: n(d.ask ?? depth?.sell?.[0]?.price) || undefined,
      ts: Date.now(),
    }
    s.lastTick.set(symbol, tick)
    fanout()
  } else if (type === 'order_update') {
    // reused OpenAlgo dock components listen on this window event
    try {
      window.dispatchEvent(new CustomEvent('oa:blotter-refresh'))
    } catch {
      /* ignore */
    }
  } else if (type === 'auth' || type === 'subscribe') {
    // ack — nothing to do
  } else if (type === 'error') {
    // keep the socket; failures surface through REST fallbacks
  }
}

function send(obj: Record<string, unknown>): boolean {
  const s = state()
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    try {
      s.ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }
  return false
}

function connect() {
  const s = state()
  if (typeof window === 'undefined') return
  if (s.ws && (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING))
    return
  if (!s.wsUrl || !s.apiKey) return // credentials not injected yet — page will retry
  let ws: WebSocket
  try {
    ws = new WebSocket(s.wsUrl)
  } catch {
    scheduleReconnect()
    return
  }
  s.ws = ws
  ws.onopen = () => {
    s.attempts = 0
    send({ action: 'authenticate', api_key: s.apiKey })
    try {
      send({ action: 'subscribe_orders' })
    } catch {
      /* optional */
    }
    emitStatus(true)
    // resubscribe everything wanted
    s.sent.clear()
    const entries = [...s.wanted.keys()]
    if (entries.length) subscribeBatch(entries)
    if (s.ping) clearInterval(s.ping)
    s.ping = setInterval(() => {
      send({ action: 'ping' })
    }, 20_000)
  }
  ws.onmessage = handleMessage
  ws.onclose = () => {
    emitStatus(false)
    if (s.ping) {
      clearInterval(s.ping)
      s.ping = null
    }
    s.ws = null
    s.sent.clear()
    scheduleReconnect()
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

function scheduleReconnect() {
  const s = state()
  if (s.timer) clearTimeout(s.timer)
  if (s.attempts >= 10) return
  const delay = Math.min(30_000, 1000 * 2 ** s.attempts)
  s.attempts += 1
  s.timer = setTimeout(() => {
    connect()
  }, delay)
}

function subscribeBatch(symbols: string[]) {
  const s = state()
  const batch = symbols
    .filter((sym) => !s.sent.has(sym))
    .map((sym) => ({ symbol: sym, exchange: resolveExchange(sym) }))
  if (!batch.length) return
  if (send({ action: 'subscribe', symbols: batch, mode: 2 })) {
    for (const b of batch) s.sent.add(b.symbol)
  }
}

function ensureLoop() {
  const s = state()
  if (s.timer) return
  const tick = () => {
    // flush pending subscriptions when the socket turns ready
    if (s.ws && s.ws.readyState === WebSocket.OPEN && s.pending.size) {
      const p = [...s.pending]
      s.pending.clear()
      subscribeBatch(p)
    }
    // prune stale ticks (6s TTL, upstream behaviour)
    const now = Date.now()
    if (now - s.lastSweep > 6_000) {
      s.lastSweep = now
      let dropped = false
      for (const [sym, t] of s.lastTick) {
        if (now - t.ts > 6_000) {
          s.lastTick.delete(sym)
          dropped = true
        }
      }
      if (dropped && s.tickListeners.size) fanout()
    }
    connect()
  }
  s.timer = setInterval(tick, 500)
}

export function ensureSocket(): { connected: boolean } {
  ensureLoop()
  const s = state()
  connect()
  return { connected: s.up }
}

export function onTicks(fn: TickListener): () => void {
  const s = state()
  s.tickListeners.add(fn)
  ensureLoop()
  return () => {
    s.tickListeners.delete(fn)
  }
}

export function onFeedStatus(fn: StatusListener): () => void {
  const s = state()
  s.statusListeners.add(fn)
  fn(s.up)
  return () => {
    s.statusListeners.delete(fn)
  }
}

export function subscribeTicks(symbols: string[]) {
  const s = state()
  for (const sym of symbols) {
    if (!sym) continue
    const n = (s.wanted.get(sym) ?? 0) + 1
    s.wanted.set(sym, n)
    if (n === 1) s.pending.add(sym)
  }
  ensureLoop()
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    const p = [...s.pending]
    s.pending.clear()
    subscribeBatch(p)
  }
}

export function unsubscribeTicks(symbols: string[]) {
  const s = state()
  const gone: string[] = []
  for (const sym of symbols) {
    const n = (s.wanted.get(sym) ?? 0) - 1
    if (n <= 0) {
      s.wanted.delete(sym)
      s.sent.delete(sym)
      gone.push(sym)
    } else s.wanted.set(sym, n)
  }
  for (const sym of gone) {
    send({ action: 'unsubscribe', symbol: sym, exchange: resolveExchange(sym), mode: 2 })
    s.lastTick.delete(sym)
  }
}
