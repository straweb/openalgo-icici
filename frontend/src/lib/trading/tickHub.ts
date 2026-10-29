/**
 * One LTP socket for every surface that wants tick updates but does not own
 * a chart terminal.
 *
 * The deploy panel's ladder used to ask the REST quotes endpoint every four
 * seconds, which read as a second-class price beside the chart's
 * tick-by-tick wire and burned a request per row on every beat. The hub is
 * the fix's shared half: one OpenAlgoWsFeed in LTP mode, the mode the
 * terminal already trusts for index feeds and option legs, carrying every
 * symbol its watchers asked for. A watcher subscribes per symbol and gets
 * that symbol's ticks; the socket connects when the first watcher arrives
 * and closes when the last leaves, so a closed panel leaves no wire behind.
 *
 * Ref-counted through `acquire` / `release` because a config change (a new
 * apikey or ws url) has to tear the socket down and rebuild it on the next
 * watch, not because accounting is interesting.
 */

import { OpenAlgoWsFeed } from 'openalgo-charts'

export interface TickQuote {
  ltp: number
  timeSec: number
}

export type TickListener = (symbol: string, exchange: string, quote: TickQuote) => void

interface HubConfig {
  apiKey: string
  wsUrl: string
}

interface Watch {
  symbol: string
  exchange: string
  listeners: Set<TickListener>
  /** Whether the mode frame has gone out on the current socket. */
  on: boolean
}

const keyOf = (symbol: string, exchange: string): string => `${exchange}:${symbol}`

class TickHub {
  private cfg: HubConfig | null = null
  private users = 0
  private ws: OpenAlgoWsFeed | null = null
  private offLtp: (() => void) | null = null
  private watching = new Map<string, Watch>()
  /** The last tick per key, so a late watcher sees a price before the next tick. */
  private last = new Map<string, TickQuote>()

  /** A page surface takes its share of the socket. Call once per mount. */
  acquire(cfg: HubConfig): void {
    this.users += 1
    const changed =
      this.cfg !== null && (this.cfg.apiKey !== cfg.apiKey || this.cfg.wsUrl !== cfg.wsUrl)
    if (this.cfg === null || changed) {
      if (changed) this.teardownSocket()
      this.cfg = cfg
    }
  }

  /** The surface unmounted. The socket closes when the last one leaves. */
  release(): void {
    this.users = Math.max(0, this.users - 1)
    if (this.users === 0) this.teardownSocket()
  }

  /**
   * Follow one instrument's ticks. Returns the stopper; the subscription is
   * ref-counted across watchers, and the socket's subscribe is idempotent.
   */
  watch(symbol: string, exchange: string, listener: TickListener): () => void {
    if (!this.cfg) return () => {}
    const key = keyOf(symbol, exchange)
    let entry = this.watching.get(key)
    if (!entry) {
      entry = { symbol, exchange, listeners: new Set(), on: false }
      this.watching.set(key, entry)
      // The feed holds the frame until the handshake lands and replays its
      // desired subscriptions after a reconnect, so the subscribe is sent
      // unconditionally rather than gated on isReady().
      const ws = this.ws ?? this.ensureSocket()
      if (ws) {
        ws.subscribe('LTP', symbol, exchange)
        entry.on = true
      }
    }
    entry.listeners.add(listener)
    const known = this.last.get(key)
    if (known) listener(symbol, exchange, known)
    return () => {
      const current = this.watching.get(key)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      if (current.on && this.ws) this.ws.unsubscribe('LTP', symbol, exchange)
      this.watching.delete(key)
      this.last.delete(key)
    }
  }

  /** The last tick seen for an instrument, or undefined before the first one. */
  snapshot(symbol: string, exchange: string): TickQuote | undefined {
    return this.last.get(keyOf(symbol, exchange))
  }

  private teardownSocket(): void {
    this.offLtp?.()
    this.offLtp = null
    this.ws?.close()
    this.ws = null
    for (const entry of this.watching.values()) entry.on = false
    this.last.clear()
  }

  private ensureSocket(): OpenAlgoWsFeed | null {
    if (!this.cfg) return null
    if (this.ws) return this.ws
    const ws = new OpenAlgoWsFeed({ url: this.cfg.wsUrl, apiKey: this.cfg.apiKey })
    this.offLtp = ws.onLtp((e) => {
      if (e.ltp <= 0) return
      const key = keyOf(e.symbol, e.exchange)
      const quote: TickQuote = { ltp: e.ltp, timeSec: e.timeSec }
      this.last.set(key, quote)
      const entry = this.watching.get(key)
      if (!entry) return
      for (const listener of entry.listeners) listener(e.symbol, e.exchange, quote)
    })
    ws.connect()
    this.ws = ws
    return ws
  }
}

/** The page's one hub. Mounted surfaces acquire; the module keeps no state of its own. */
export const tickHub = new TickHub()
