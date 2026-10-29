/**
 * Synthesized index volume, built from the index's constituent stocks.
 *
 * An index spot chart often carries no volume at all — several brokers'
 * feeds report the index level only — so the histogram on such a chart is
 * either hidden or a flat zero, and the trader loses the one reading that
 * says how much of the move was done on real turnover. This module rebuilds
 * that histogram by hand: every stock in the index's constituent profile
 * (lib/hedging/indexConstituents) contributes its own traded volume, and the
 * sum per time bucket stands in for the index's.
 *
 * Two feeds make it up:
 *
 * - **Backfill.** One 1-minute history read per member for today's session,
 *   paced a few at a time (the broker's request budget is shared — the
 *   server's rate limiter paces what is left of it), summed per minute
 *   bucket. Runs once per index per day per page; the result is cached for
 *   every chart and every timeframe the session opens after it.
 * - **Live.** One multiquotes poll every few seconds over the whole member
 *   list. Each member's cumulative day volume is compared with the last
 *   snapshot, and the delta lands in the minute bucket forming now — the
 *   same accumulate-per-minute-close the Constituents table does, just
 *   feeding the chart instead of a study strip.
 *
 * The consumer bins the minute buckets onto the chart's own bar times, so
 * the sum lines up with whatever timeframe the chart is on — 1m, 5m, 15m,
 * an hour — without this module knowing how the exchange aligns sessions.
 * Buckets land on the bar whose start they fall inside; a bucket newer than
 * every bar waits for the chart to open that bar rather than leaking into
 * the previous one.
 */

import type { Bar } from 'openalgo-charts'
import { apiClient } from '@/api/client'
import { tradingApi } from '@/api/trading'
import type { IndexProfile } from '@/lib/hedging/indexConstituents'

/** Members' history reads go out this many at a time, to stay under the budget. */
const BACKFILL_CONCURRENCY = 3

/** The live poll stride: deltas are minute-scale, seconds of lag are fine. */
const LIVE_POLL_MS = 6000

/** multiquotes takes 40 symbols a call; a Nifty 50 back is two. */
const QUOTE_BATCH = 40

/** The history client's row shape (POST /api/v1/history). */
interface HistoryRow {
  timestamp: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
}

/** `YYYY-MM-DD` for the session's calendar day, in the exchange's own clock. */
export function istDateString(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return parts
}

/**
 * One index's synthesized volume: today's per-minute summed turnover, kept
 * current by the live poll, binned on demand onto whatever bars a chart
 * holds. One instance per index per day — several charts of the same index
 * (and the Constituentst table beside them) share it through the registry
 * below.
 */
export class IndexVolumeFeed {
  /** Summed member volume per minute bucket (bucket start, epoch seconds). */
  private buckets = new Map<number, number>()
  /** Each member's last seen cumulative day volume, the delta's baseline. */
  private lastSeen = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private stopped = false
  private backfill: Promise<void> | null = null
  private timer = 0
  readonly dayKey: string
  private readonly apiKey: string
  private readonly profile: IndexProfile
  private readonly onEmpty?: () => void

  constructor(apiKey: string, profile: IndexProfile, onEmpty?: () => void) {
    this.apiKey = apiKey
    this.profile = profile
    this.onEmpty = onEmpty
    this.dayKey = `${profile.underlying}:${istDateString()}`
  }

  /** Start the backfill and the live poll. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return
    void this.runBackfill()
    this.timer = window.setInterval(() => void this.poll(), LIVE_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) window.clearInterval(this.timer)
    this.timer = 0
    this.listeners.clear()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  /** Total member volume recorded so far — zero means the backfill found nothing. */
  size(): number {
    return this.buckets.size
  }

  private add(bucket: number, volume: number): void {
    if (!(volume > 0)) return
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + volume)
  }

  /**
   * One 1-minute history read per member, a few at a time, summed per bucket.
   * A member that fails (a thin master contract, a feed hiccup) is skipped —
   * the sum of the rest is still the shape of the day's turnover, and the
   * live poll keeps adding to it.
   */
  private runBackfill(): Promise<void> {
    if (this.backfill) return this.backfill
    this.backfill = (async () => {
      const day = istDateString()
      const members = this.profile.constituents.map((row) => row.symbol)
      let cursor = 0
      const workers = Array.from({ length: Math.min(BACKFILL_CONCURRENCY, members.length) }, () =>
        (async () => {
          while (!this.stopped) {
            const index = cursor++
            if (index >= members.length) return
            const symbol = members[index]
            try {
              const res = await apiClient.post<{ status: string; data?: HistoryRow[] }>(
                '/history',
                {
                  apikey: this.apiKey,
                  symbol,
                  exchange: this.profile.stockExchange,
                  interval: '1m',
                  start_date: day,
                  end_date: day,
                }
              )
              for (const row of res.data?.data ?? []) {
                this.add(Number(row.timestamp), Number(row.volume) || 0)
              }
            } catch {
              // the live poll still accumulates this member from its baseline
            }
          }
        })()
      )
      await Promise.all(workers)
      this.emit()
    })()
    return this.backfill
  }

  /**
   * The live half: cumulative day volume per member, delta into the forming
   * minute. The first poll only sets the baseline — the backfill already
   * holds everything closed before it — so no bucket is ever counted twice.
   */
  private async poll(): Promise<void> {
    if (this.stopped) return
    const members = this.profile.constituents.map((row) => ({
      symbol: row.symbol,
      exchange: this.profile.stockExchange,
    }))
    let changed = false
    for (let i = 0; i < members.length; i += QUOTE_BATCH) {
      const batch = members.slice(i, i + QUOTE_BATCH)
      try {
        const res = await tradingApi.getMultiQuotes(this.apiKey, batch)
        for (const item of res.results ?? []) {
          const cumulative = Number(item.data?.volume) || 0
          const previous = this.lastSeen.get(item.symbol)
          this.lastSeen.set(item.symbol, cumulative)
          if (previous == null || cumulative < previous) continue
          const delta = cumulative - previous
          if (delta > 0) {
            this.add(Math.floor(Date.now() / 60000) * 60, delta)
            changed = true
          }
        }
      } catch {
        // the next stride tries again; the backfill already covers the session
      }
      if (this.stopped) return
    }
    if (changed) this.emit()
    else if (this.buckets.size === 0) this.onEmpty?.()
  }

  /**
   * The minute buckets binned onto the chart's own bar times.
   *
   * Two pointers over two sorted lists: each bucket joins the bar whose
   * start it falls inside — the last bar no later than the bucket — and a
   * bucket that would fall past a bar's own span (the chart has not opened
   * that bar yet) waits, rather than padding the bar before it. Bars older
   * than today's buckets read zero, which is honest: this feed only knows
   * the session it was built on.
   */
  volumeForBars(bars: readonly Bar[], intervalSec: number): Map<number, number> {
    const out = new Map<number, number>()
    if (bars.length === 0 || this.buckets.size === 0) return out
    const bucketTimes = [...this.buckets.keys()].sort((a, b) => a - b)
    let i = 0
    for (const bucket of bucketTimes) {
      while (i < bars.length - 1 && bars[i + 1].time <= bucket) i++
      const bar = bars[i]
      if (bar.time <= bucket && bucket - bar.time < intervalSec) {
        out.set(bar.time, (out.get(bar.time) ?? 0) + (this.buckets.get(bucket) ?? 0))
      }
    }
    return out
  }
}

/* ── registry: one feed per index per day, shared by every chart ─────────── */

const active = new Map<string, IndexVolumeFeed>()

/**
 * The shared feed for an index's synthesized volume, started on first ask.
 * `onEmpty` fires when a poll turns up nothing at all — the caller uses it
 * to keep the histogram honest instead of drawing a flat zero forever.
 */
export function sharedIndexVolumeFeed(
  apiKey: string,
  profile: IndexProfile,
  onEmpty?: () => void
): IndexVolumeFeed {
  const key = `${profile.underlying}:${istDateString()}`
  const existing = active.get(key)
  if (existing) return existing
  const feed = new IndexVolumeFeed(apiKey, profile, onEmpty)
  active.set(key, feed)
  feed.start()
  return feed
}

/** Yesterday's feeds (and a stale session's) release their timers here. */
export function pruneIndexVolumeFeeds(): void {
  for (const [key, feed] of active) {
    // A feed's key ends with its IST date (`NIFTY:2026-10-29`); anything not
    // today's is a stale session nobody reads anymore.
    if (!key.endsWith(istDateString())) {
      feed.stop()
      active.delete(key)
    }
  }
}
