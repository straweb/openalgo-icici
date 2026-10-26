/**
 * The index-price deploy planner (pure side).
 *
 * The trader reads the index chart, not the option chain: "deploy CE when
 * NIFTY takes 24,500, close it at 24,650, bail at 24,420". This module turns
 * that intent into the pieces the terminal already runs:
 *
 * - `strikesForPick` — which strikes a pick mode means: the ATM itself, the
 *   n strikes above it, the n below it, or an explicit list.
 * - `closeTriggerFor` — the level-cross direction that closes a position
 *   profitably, so target and stop arm as scheduler price rows on the spot.
 *
 * Everything here is pure so the dialog stays a form and the engine in the
 * page stays a dispatcher.
 */

import type { StrikeSide } from '@/types/hedging'

export type StrikePickMode = 'atm' | 'above' | 'below' | 'custom'

export interface StrikePick {
  mode: StrikePickMode
  /** Strikes above/below ATM for the offset modes, 1..7. */
  count?: number
  /** Explicit strikes for the custom mode. */
  strikes?: number[]
}

/**
 * The strike list a pick means, deduplicated and in ascending order.
 * `above` counts strikes strictly above ATM, `below` strictly below; the ATM
 * itself is only ever in the `atm` mode. Custom strikes are taken as given.
 */
export function strikesForPick(
  pick: StrikePick,
  atm: number | null | undefined,
  interval: number | null | undefined
): number[] {
  if (pick.mode === 'custom') {
    return [...new Set(pick.strikes ?? [])]
      .filter((s) => Number.isFinite(s) && s > 0)
      .sort((a, b) => a - b)
  }
  if (atm == null || !interval || interval <= 0) return []
  if (pick.mode === 'atm') return [atm]
  const count = Math.max(1, Math.min(10, Math.floor(pick.count ?? 1)))
  const dir = pick.mode === 'above' ? 1 : -1
  const strikes: number[] = []
  for (let offset = 1; offset <= count; offset++) strikes.push(atm + dir * offset * interval)
  return strikes.sort((a, b) => a - b)
}

export type LevelCross = 'above' | 'below'

/**
 * One dotted strike rail on the spot index chart: the strike's price level,
 * its ATM offset badge and a colour that reads moneyness at a glance — the
 * ATM itself amber (the anchor), every other strike a fading slate that gets
 * lighter the further out it sits.
 */
export interface StrikeMarkerLine {
  id: string
  price: number
  color: string
  badge?: string
  dotted: true
}

/**
 * The human ATM offset of a strike in interval units — 'ATM', 'ATM+2',
 * 'ATM−3' — or null when the chain snapshot has not landed yet.
 */
export function strikeOffsetLabel(
  strike: number,
  atm: number | null | undefined,
  interval: number | null | undefined
): string | null {
  if (atm == null || !interval || interval <= 0) return null
  const offset = Math.round((strike - atm) / interval)
  if (offset === 0) return 'ATM'
  return offset > 0 ? `ATM+${offset}` : `ATM−${Math.abs(offset)}`
}

/**
 * One dotted marker line per unique strike, in ascending order, for the spot
 * index chart. Both panels' strikes feed the same rails — a strike hosts its
 * CE and its PE at one price — so duplicates collapse. The ATM anchor carries
 * a brighter amber; the ladder fades outward so distance from ATM reads as
 * pure colour weight, the same grammar the strike panels' accents use.
 */
export function strikeMarkerLines(
  strikes: number[],
  atm: number | null | undefined,
  interval: number | null | undefined
): StrikeMarkerLine[] {
  const unique = [...new Set(strikes.filter((s) => Number.isFinite(s) && s > 0))].sort(
    (a, b) => a - b
  )
  return unique.map((strike) => {
    const offset = atm != null && interval ? Math.round((strike - atm) / interval) : null
    // Integer math keeps the alpha deterministic, like the panel accents.
    const depth = Math.abs(offset ?? 0)
    const alpha = Math.max(0.18, (70 - (depth - 1) * 8) / 100)
    return {
      id: `strike:${strike}`,
      price: strike,
      color: offset === 0 ? 'rgba(245, 158, 11, 0.9)' : `rgba(100, 116, 139, ${alpha})`,
      badge: strikeOffsetLabel(strike, atm, interval) ?? undefined,
      dotted: true,
    }
  })
}

/**
 * The spot crossing that closes `side` options traded in `optionAction`
 * profitably. Long CE and short PE profit when the index rises; long PE and
 * short CE when it falls. The stop mirrors the target.
 */
export function profitCross(side: StrikeSide, optionAction: 'BUY' | 'SELL'): LevelCross {
  const long = optionAction === 'BUY'
  return side === 'CE' ? (long ? 'above' : 'below') : long ? 'below' : 'above'
}

/** The target/stop crossings for a position, for the dialog's preview line. */
export function levelCrosses(
  side: StrikeSide,
  optionAction: 'BUY' | 'SELL'
): { target: LevelCross; stop: LevelCross } {
  const target = profitCross(side, optionAction)
  return { target, stop: target === 'above' ? 'below' : 'above' }
}

/**
 * A one-line human summary of the plan, shown in the dialog before it arms:
 * "Deploy CE · NIFTY ≥ 24,500 · close ≤ 24,420 / ≥ 24,650".
 */
export function indexDeploySummary(parts: {
  side: StrikeSide
  optionAction: 'BUY' | 'SELL'
  strikes: number[]
  entry?: number | null
  target?: number | null
  stop?: number | null
  spotSymbol?: string
}): string {
  const name = parts.spotSymbol ?? 'index'
  const fmt = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const target = levelCrosses(parts.side, parts.optionAction)
  const bits = [
    `${parts.optionAction === 'BUY' ? 'Buy' : 'Sell'} ${parts.strikes.length} × ${parts.side}`,
  ]
  if (parts.entry != null) {
    const entryCross: LevelCross =
      parts.side === 'CE'
        ? parts.optionAction === 'BUY'
          ? 'above'
          : 'below'
        : parts.optionAction === 'BUY'
          ? 'below'
          : 'above'
    bits.push(`enter when ${name} ${entryCross === 'above' ? '≥' : '≤'} ${fmt(parts.entry)}`)
  } else {
    bits.push('enter now')
  }
  if (parts.target != null)
    bits.push(`exit when ${name} ${target.target === 'above' ? '≥' : '≤'} ${fmt(parts.target)}`)
  if (parts.stop != null)
    bits.push(`stop when ${name} ${target.stop === 'above' ? '≥' : '≤'} ${fmt(parts.stop)}`)
  return bits.join(' · ')
}
