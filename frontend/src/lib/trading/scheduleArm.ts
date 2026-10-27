import {
  scheduledFromSubmission,
  type SchedulerSubmit,
} from '@/components/hedging/SchedulerDialog'
import { istSeconds, parseClock } from '@/lib/hedging/scheduler'
import { planForLadderBatch } from '@/lib/trading/tradingFire'
import type { Ladder } from '@/lib/trading/tradingFire'
import { fnoExchangeFor, type ScheduledOrder } from '@/types/hedging'

/**
 * Arm a scheduled batch against the charting terminal's deploy ladder — the
 * submission-to-store path the dock's Scheduled tab runs, shared so the
 * Deploy panel's Schedule button produces identical rows.
 *
 * The row is stamped `origin: 'trading'`, so this page's engine fires it
 * and the hedging terminal's engine leaves it alone. The batch names its
 * ladder through the deploy plan's spot (the underlying), and records the
 * strikes that side had enabled at arm time — an empty list reads as
 * "whatever that side has enabled when it fires".
 *
 * A time already passed must not fire the moment it lands: a once entry
 * retires as missed, a daily entry waits for tomorrow's pass.
 */

export interface ArmBatchContext {
  /** The underlying whose ladder the batch runs. */
  underlying: string
  spot: { symbol: string; exchange: string } | null
  /** That underlying's ladder as it stands at arm time. */
  ladder?: Ladder
}

/** The side a batch verb runs: A reads CE, B reads PE (the F&O vocabulary). */
export function sideOfBatchAction(action: ScheduledOrder['action']): 'CE' | 'PE' {
  return action === 'deployB' || action === 'closeB' ? 'PE' : 'CE'
}

export function armLadderBatch(submission: SchedulerSubmit, ctx: ArmBatchContext): ScheduledOrder {
  const row = scheduledFromSubmission(submission, 'fno', 'trading')
  const optionsExchange = fnoExchangeFor('NSE')
  const side = sideOfBatchAction(row.action)
  const sideRows = ctx.ladder ? ctx.ladder[side === 'CE' ? 'ce' : 'pe'] : []
  row.deploy = planForLadderBatch({
    action: row.action,
    side,
    spot: ctx.spot ?? { symbol: ctx.underlying, exchange: 'NSE_INDEX' },
    enabledStrikes:
      row.action === 'exitAll'
        ? []
        : (sideRows ?? []).filter((r) => r.enabled).map((r) => r.strike),
  })
  row.deploy.exchange = optionsExchange
  if (row.trigger.kind === 'time') {
    const target = parseClock(row.trigger.at)
    if (target != null && target <= istSeconds(new Date())) {
      if (row.trigger.repeat === 'daily') {
        row.firedAt = Date.now()
      } else {
        row.status = 'missed'
      }
    }
  }
  return row
}

/** Whether an armed row's time already passed (missed once, or rolled to tomorrow). */
export function armPastMiss(row: ScheduledOrder): 'missed' | 'daily' | null {
  if (row.status === 'missed') return 'missed'
  if (row.trigger.kind === 'time' && row.firedAt && row.trigger.repeat === 'daily') return 'daily'
  return null
}
