/**
 * A live spot/index feed for the embeddable charts: the OpenAlgo history
 * REST endpoint for the bars, one LTP WebSocket subscription for the ticks,
 * and a CandleBuilder to fold the ticks into the forming candle.
 *
 * It exists so a surface that already knows its instrument — the deploy
 * panel's index chart — can render a real, live chart without dragging the
 * whole trading terminal along. `getBars` speaks the same /api/v1/history
 * contract the engine's own OpenAlgoDataFeed speaks; `subscribeBars` runs
 * one mode-LTP socket per chart, which is what an index (no order book)
 * wants anyway.
 *
 * Everything here degrades quietly: a failed history ask is an empty chart
 * with the host's own message, a failed socket is history without the
 * forming candle. Nothing throws into the host's render.
 */

import type { Bar, BarsRequest, DataFeed, SymbolMatch, SymbolSearchRequest } from 'openalgo-charts'
import { CandleBuilder, OpenAlgoWsFeed } from 'openalgo-charts'

/** The wire names the history endpoint takes for the calendar frames. */
const WIRE_INTERVAL: Record<string, string> = {
  '1d': 'D',
  '1D': 'D',
  '1w': 'W',
  '1W': 'W',
  '1M': 'M',
  MN: 'M',
}

/** UTC seconds → the YYYY-MM-DD the history endpoint's window fields take. */
const utcDate = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)

interface SpotFeedConfig {
  apiKey: string
  /** The WebSocket proxy URL (wss://host/ws in production). */
  wsUrl: string
}

/** One LTP socket per subscribe — the engine calls it once per live chart. */
export function createSpotFeed(config: SpotFeedConfig): DataFeed {
  return {
    async getBars(req: BarsRequest): Promise<Bar[]> {
      const { from, to } = req
      if (from == null || to == null) return []
      const wire = WIRE_INTERVAL[req.interval] ?? req.interval
      const res = await fetch('/api/v1/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: config.apiKey,
          symbol: req.symbol,
          exchange: req.exchange,
          interval: wire,
          start_date: utcDate(from),
          end_date: utcDate(to),
        }),
      })
      if (!res.ok) throw new Error(`history request failed (${res.status})`)
      const j = (await res.json()) as {
        status?: string
        data?: Array<{
          timestamp?: number
          time?: number
          open: number
          high: number
          low: number
          close: number
          volume?: number
        }>
      }
      if (j.status === 'error') throw new Error('OpenAlgo history request failed')
      const bars: Bar[] = []
      for (const row of j.data ?? []) {
        const raw = row.timestamp ?? row.time
        const time =
          typeof raw === 'number' ? (raw > 1e12 ? Math.floor(raw / 1000) : raw) : undefined
        if (time == null) continue
        bars.push({
          time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        })
      }
      return bars.sort((a, b) => a.time - b.time)
    },

    async searchSymbols(request: SymbolSearchRequest): Promise<SymbolMatch[]> {
      // The embeddable chart never offers symbol search — its host owns the pick.
      void request
      return []
    },

    subscribeBars(req: BarsRequest, onBar: (bar: Bar) => void): () => void {
      let closed = false
      let offLtp: (() => void) | null = null
      let socket: InstanceType<typeof OpenAlgoWsFeed> | null = null
      try {
        socket = new OpenAlgoWsFeed({ url: config.wsUrl, apiKey: config.apiKey })
        // The forming candle folds the ticks on the request's own frame.
        // Daily-and-above has no intraday frame to fold on, so the chart
        // simply stays on history until the next load.
        const sec = intradaySeconds(req.interval)
        const builder =
          sec != null ? new CandleBuilder({ intervalSec: sec, volumeMode: 'ltq-sum' }) : null
        offLtp = socket.onLtp((e) => {
          if (closed || !builder) return
          if (e.symbol !== req.symbol || e.exchange !== req.exchange) return
          if (!(e.ltp > 0)) return
          try {
            const u = builder.onTick({
              time: e.timeSec ?? Math.floor(Date.now() / 1000),
              price: e.ltp,
            })
            if (u) onBar(u.bar)
          } catch {
            // An off-session quote must not break the feed.
          }
        })
        socket.connect()
        socket.subscribe('LTP', req.symbol, req.exchange)
      } catch {
        // No socket: the chart is history-only. The host says nothing.
      }
      return () => {
        closed = true
        offLtp?.()
        try {
          socket?.close()
        } catch {
          /* already closed */
        }
      }
    },
  }
}

/** Intraday frames only, in seconds — null for D/W/M, which do not tick-fold. */
function intradaySeconds(interval: string): number | null {
  const m = /^(\d+)(m|h)$/.exec(interval)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return m[2] === 'm' ? n * 60 : n * 3600
}
