import type { Bar } from 'openalgo-charts'
import { describe, expect, it } from 'vitest'
import { constituentsFor } from '@/lib/hedging/indexConstituents'
import { IndexVolumeFeed, istDateString } from './indexVolume'

/**
 * The binning is the whole point: member-stock minute buckets have to land
 * on the chart's own bar times — whatever the timeframe — or the synthesized
 * histogram lies about where turnover happened.
 */

const bar = (time: number, volume?: number): Bar => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume,
})

/** A feed fed directly, without its polls: the registry only observes. */
function feedWithBuckets(buckets: Array<[number, number]>): IndexVolumeFeed {
  const feed = new IndexVolumeFeed('test-key', constituentsFor('NIFTY')!)
  // add() is the same summing write the backfill and the live poll use —
  // called once per member read, so same-bucket entries accumulate.
  const add = (feed as unknown as { add(bucket: number, volume: number): void }).add
  for (const [time, volume] of buckets) add.call(feed, time, volume)
  return feed
}

describe('index volume binning', () => {
  it('bins each minute bucket onto the bar whose start it falls inside', () => {
    // A 5m chart: bars at :00, :05, :10. Five 1m buckets per bar.
    const feed = feedWithBuckets([
      [0, 10],
      [60, 20],
      [120, 30],
      [180, 40],
      [240, 50], // first bar's five minutes
      [300, 5], // second bar's first minute
    ])
    const map = feed.volumeForBars([bar(0), bar(300), bar(600)], 300)
    expect(map.get(0)).toBe(150)
    expect(map.get(300)).toBe(5)
    expect(map.size).toBe(2)
  })

  it('holds a bucket newer than every bar instead of padding the last one', () => {
    // The chart has not opened the :05 bar yet; the :05 bucket must wait.
    const feed = feedWithBuckets([
      [0, 10],
      [60, 5],
      [300, 7],
    ])
    const map = feed.volumeForBars([bar(0)], 300)
    expect(map.get(0)).toBe(15)
    expect(map.size).toBe(1)
  })

  it("works on a daily chart: a day's buckets land on the day's bar", () => {
    const day = 86400
    const feed = feedWithBuckets([
      [day + 9 * 3600, 100],
      [day + 10 * 3600, 200],
    ])
    const map = feed.volumeForBars([bar(0), bar(day)], day)
    expect(map.get(day)).toBe(300)
    expect(map.get(0)).toBeUndefined()
  })

  it('sums across members: the same bucket from two reads adds up', () => {
    // Two members each report 10 in the same minute — the index bar shows 20.
    const feed = feedWithBuckets([
      [0, 10],
      [0, 10],
    ])
    const map = feed.volumeForBars([bar(0)], 60)
    expect(map.get(0)).toBe(20)
  })

  it('answers empty with no bars or no buckets', () => {
    expect(feedWithBuckets([[0, 5]]).volumeForBars([], 60).size).toBe(0)
    expect(feedWithBuckets([]).volumeForBars([bar(0)], 60).size).toBe(0)
  })
})

describe('istDateString', () => {
  it('reads the exchange calendar day, not the server UTC one', () => {
    // 2026-01-31 20:30 UTC is 2026-02-01 02:00 IST — the session date rolls.
    const utcEvening = new Date('2026-01-31T20:30:00Z')
    expect(istDateString(utcEvening)).toBe('2026-02-01')
  })
})
