/**
 * The scheduled book, from the charting terminal.
 *
 * The scheduler's store is shared with the hedging terminal: one localStorage
 * key, two engines. This tab reads it, arms onto it, and — the part that
 * makes the tab live rather than a mirror — fires the batches it armed
 * itself: every row stamped `origin: 'trading'` runs the charting page's
 * deploy ladder when it comes due, through the page's engine. The hedging
 * terminal's rows still wait for that page's engine, which alone knows its
 * boards; they show here so the whole book is in one place.
 *
 * The Schedule button is the hedging terminal's dialog, narrowed: the batch
 * verbs run the ladder (Deploy/Close CE/PE, Exit All), and the trigger is a
 * clock time (IST, to the second, optionally daily) or a price level or band
 * on an instrument the page can quote. Cancel flips a pending row to
 * history and Repeat arms a fresh copy — the same verbs the hedging dock
 * offers.
 */

import { CalendarClock, RefreshCw, Timer } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  scheduledFromSubmission,
  SchedulerDialog,
  type SchedulerSubmit,
} from '@/components/hedging/SchedulerDialog'
import { useSpotResolution } from '@/components/trading/dock/useSpotResolution'
import {
  istSeconds,
  parseClock,
  scheduleActionLabel,
  scheduleTriggerLabel,
} from '@/lib/hedging/scheduler'
import { loadHedgingState, saveHedgingState } from '@/lib/hedging/storage'
import { fnoExchangeFor, type ScheduledOrder } from '@/types/hedging'
import { readDeployState } from '@/lib/trading/deployPlan'
import { planForLadderBatch } from '@/lib/trading/tradingFire'
import { cn } from '@/lib/utils'
import { showToast } from '@/utils/toast'

const POLL_MS = 2000

const statusTone = (status: ScheduledOrder['status']) => {
  if (status === 'pending') return 'bg-amber-500'
  if (status === 'done') return 'bg-emerald-600'
  if (status === 'missed') return 'bg-red-600'
  return 'bg-muted text-muted-foreground'
}

function firedAtLabel(entry: ScheduledOrder): string {
  if (!entry.firedAt) return '—'
  const at = new Date(entry.firedAt)
  return at.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
}

/** The side a batch verb runs: A reads CE, B reads PE (the F&O vocabulary). */
function sideOfAction(action: ScheduledOrder['action']): 'CE' | 'PE' {
  return action === 'deployB' || action === 'closeB' ? 'PE' : 'CE'
}

interface Props {
  apiKey: string
  /** The focused pane's symbol — the underlying whose ladder the batches run. */
  activeSymbol: string | null
}

export function ScheduledTab({ apiKey, activeSymbol }: Props) {
  const [scheduled, setScheduled] = useState<ScheduledOrder[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const { spot } = useSpotResolution(apiKey, activeSymbol)

  const reload = useCallback(() => {
    setScheduled(loadHedgingState().scheduled)
  }, [])

  // The engines write whenever a batch fires or the trader edits in either
  // terminal, so the view re-reads instead of holding a stale copy.
  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, POLL_MS)
    return () => window.clearInterval(timer)
  }, [reload])

  /** Arm a batch: a dialog submission becomes a store row this page fires. */
  const submit = useCallback(
    (submission: SchedulerSubmit) => {
      if (!activeSymbol) return
      const row = scheduledFromSubmission(submission, 'fno', 'trading')
      // The batch names its ladder (the spot carries the underlying) and the
      // strikes that side had enabled at arm time — an empty list means "the
      // side's enabled rows as they stand when it fires".
      const optionsExchange = fnoExchangeFor('NSE')
      const book = readDeployState().books[`${optionsExchange}:${activeSymbol}`]
      const ladder = sideOfAction(row.action) === 'CE' ? book?.ce : book?.pe
      row.deploy = planForLadderBatch({
        action: row.action,
        side: sideOfAction(row.action),
        spot: spot ?? { symbol: activeSymbol, exchange: 'NSE_INDEX' },
        enabledStrikes:
          row.action === 'exitAll' ? [] : (ladder ?? []).filter((r) => r.enabled).map((r) => r.strike),
      })
      row.deploy.exchange = optionsExchange
      // A time already passed must not fire the moment it is armed: a once
      // entry retires as missed, a daily entry waits for tomorrow's pass.
      if (row.trigger.kind === 'time') {
        const target = parseClock(row.trigger.at)
        if (target != null && target <= istSeconds(new Date())) {
          if (row.trigger.repeat === 'daily') {
            row.firedAt = Date.now()
            showToast.info(`${row.trigger.at} IST has passed — it runs at the next trading day's pass.`)
          } else {
            row.status = 'missed'
            showToast.warning(`${row.trigger.at} IST has already passed — nothing scheduled.`)
          }
        }
      }
      const state = loadHedgingState()
      saveHedgingState({ ...state, scheduled: [...state.scheduled, row] })
      reload()
      showToast.success(
        `${scheduleActionLabel(row.action, row.modeAtCreation, row.target)} scheduled — ${row.trigger.kind === 'time' ? `${row.trigger.at} IST` : 'on the price trigger'}. It fires from this page's deploy ladder.`
      )
    },
    [activeSymbol, spot, reload]
  )

  /** Cancel = history, not deletion — the hedging terminal's exact verb. */
  const cancel = useCallback(
    (id: string) => {
      const state = loadHedgingState()
      saveHedgingState({
        ...state,
        scheduled: state.scheduled.map((entry) =>
          entry.id === id && entry.status === 'pending'
            ? { ...entry, status: 'canceled' as const }
            : entry
        ),
      })
      reload()
      showToast.info('Scheduled batch canceled.')
    },
    [reload]
  )

  /** Repeat: arm a fresh copy of an old row (pending, never fired). */
  const repeat = useCallback(
    (entry: ScheduledOrder) => {
      const state = loadHedgingState()
      const copy: ScheduledOrder = {
        ...entry,
        id: `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'pending',
        firedAt: undefined,
        createdAt: Date.now(),
      }
      saveHedgingState({ ...state, scheduled: [...state.scheduled, copy] })
      reload()
      showToast.info(
        `Runs again: ${scheduleActionLabel(entry.action, entry.modeAtCreation, entry.target)}.`
      )
    },
    [reload]
  )

  /** The instruments a price trigger may watch, as far as this page knows. */
  const triggerSymbols = useMemo(() => {
    const list: Array<{ symbol: string; exchange: string }> = []
    if (spot) list.push(spot)
    if (activeSymbol) list.push({ symbol: activeSymbol, exchange: 'NSE' })
    return list
  }, [spot, activeSymbol])

  const scheduleButton = (
    <Button
      size="sm"
      className="h-6 gap-1 px-2 text-[10px]"
      disabled={!activeSymbol}
      title={
        activeSymbol
          ? 'Arm a batch on this underlying’s deploy ladder'
          : 'Chart an underlying first — the batches run its ladder'
      }
      onClick={() => setDialogOpen(true)}
    >
      <CalendarClock className="h-3 w-3" />
      Schedule
    </Button>
  )

  if (scheduled.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
        <Timer className="h-5 w-5 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">
          No scheduled batches. Arm one here — it fires this page's deploy ladder — or from the
          Hedging terminal, whose batches fire there.
        </p>
        {scheduleButton}
        <SchedulerDialog
          open={dialogOpen}
          mode="fno"
          initial={null}
          triggerSymbols={triggerSymbols}
          defaultSymbol={spot ?? undefined}
          spotSymbol={spot}
          actsOn={
            activeSymbol
              ? { options: `${activeSymbol} deploy ladder`, stock: activeSymbol }
              : undefined
          }
          allowStockTarget={false}
          onOpenChange={setDialogOpen}
          onSubmit={submit}
        />
      </div>
    )
  }

  const sorted = [...scheduled].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="p-2">
      <div className="mb-1 flex items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-muted-foreground">
          <RefreshCw className="h-3 w-3 shrink-0" />
          <span className="truncate">
            Batches tagged <span className="font-semibold">chart</span> fire this page's deploy
            ladder; the rest fire from the Hedging terminal. Cancel and Repeat work here.
          </span>
        </p>
        {scheduleButton}
      </div>
      <Table>
        <TableHeader>
          <TableRow className="h-6">
            <TableHead className="h-6 py-0 text-[10px]">Trigger</TableHead>
            <TableHead className="h-6 py-0 text-[10px]">Action</TableHead>
            <TableHead className="h-6 py-0 text-[10px]">Status</TableHead>
            <TableHead className="h-6 py-0 text-[10px]">Fired</TableHead>
            <TableHead className="h-6 py-0 text-right text-[10px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((entry) => {
            const label = scheduleActionLabel(entry.action, entry.modeAtCreation, entry.target)
            const plan =
              entry.deploy != null
                ? `${entry.deploy.optionAction} ${entry.deploy.strikes.length > 0 ? entry.deploy.strikes.join(', ') : `${sideOfAction(entry.action)} enabled`}`
                : null
            const pending = entry.status === 'pending'
            return (
              <TableRow key={entry.id} className="h-7">
                <TableCell className="py-0.5 font-mono text-[10px]">
                  {scheduleTriggerLabel(entry.trigger)}
                </TableCell>
                <TableCell className="py-0.5 text-[10px]">
                  {entry.origin === 'trading' && (
                    <Badge
                      className="mr-1 bg-sky-600 px-1 py-0 text-[9px] text-white"
                      title="Fires this page's deploy ladder"
                    >
                      chart
                    </Badge>
                  )}
                  {label}
                  {plan && (
                    <span className="ml-1 text-muted-foreground" title="Deploy plan">
                      · {plan}
                    </span>
                  )}
                </TableCell>
                <TableCell className="py-0.5">
                  <Badge className={cn('px-1 py-0 text-[9px]', statusTone(entry.status))}>
                    {entry.status}
                  </Badge>
                </TableCell>
                <TableCell className="py-0.5 font-mono text-[10px] tabular-nums">
                  {firedAtLabel(entry)}
                </TableCell>
                <TableCell className="py-0.5 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => repeat(entry)}
                    title="Start a fresh copy (pending, never fired)"
                  >
                    Repeat
                  </Button>
                  {pending && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-1 h-5 px-1.5 text-[10px]"
                      onClick={() => cancel(entry.id)}
                      title="Disarm: the row stays as history"
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <SchedulerDialog
        open={dialogOpen}
        mode="fno"
        initial={null}
        triggerSymbols={triggerSymbols}
        defaultSymbol={spot ?? undefined}
        spotSymbol={spot}
        actsOn={
          activeSymbol ? { options: `${activeSymbol} deploy ladder`, stock: activeSymbol } : undefined
        }
        allowStockTarget={false}
        onOpenChange={setDialogOpen}
        onSubmit={submit}
      />
    </div>
  )
}
