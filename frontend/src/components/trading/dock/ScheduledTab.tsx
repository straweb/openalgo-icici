/**
 * The scheduled book, from the charting terminal.
 *
 * The scheduler's store is shared: the Hedging terminal persists its armed
 * batches to one localStorage key and its engine fires them there. This tab
 * reads that store, so the batches are visible — and manageable — without
 * switching pages: Cancel flips a pending row to history and Repeat re-arms
 * a fresh copy, the same verbs the hedging dock offers.
 *
 * What this tab deliberately does not do is fire. Firing a batch needs the
 * hedging board's own rows, weights and chain context, and a second firing
 * engine would double-place real orders when both pages are open. The note
 * says so where the fire button would have been.
 */

import { RefreshCw, Timer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
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
  loadHedgingState,
  saveHedgingState,
} from '@/lib/hedging/storage'
import {
  scheduleActionLabel,
  scheduleTriggerLabel,
} from '@/lib/hedging/scheduler'
import type { ScheduledOrder } from '@/types/hedging'
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

/** A fresh scheduler row id, the same shape the hedging terminal mints. */
function rearmId(): string {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function ScheduledTab() {
  const [scheduled, setScheduled] = useState<ScheduledOrder[]>([])

  const reload = useCallback(() => {
    setScheduled(loadHedgingState().scheduled)
  }, [])

  // The hedging terminal owns the store and writes it whenever its engine
  // fires or the trader edits there, so the view re-reads instead of holding
  // a copy that goes stale.
  useEffect(() => {
    reload()
    const timer = window.setInterval(reload, POLL_MS)
    return () => window.clearInterval(timer)
  }, [reload])

  /** Cancel = history, not deletion — the hedging terminal's exact verb. */
  const cancel = useCallback((id: string) => {
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
  }, [reload])

  /** Repeat: arm a fresh copy of an old row (pending, never fired). */
  const repeat = useCallback((entry: ScheduledOrder) => {
    const state = loadHedgingState()
    const copy: ScheduledOrder = {
      ...entry,
      id: rearmId(),
      status: 'pending',
      firedAt: undefined,
      createdAt: Date.now(),
    }
    saveHedgingState({ ...state, scheduled: [...state.scheduled, copy] })
    reload()
    showToast.info(`Runs again: ${scheduleActionLabel(entry.action, entry.modeAtCreation, entry.target)}.`)
  }, [reload])

  if (scheduled.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 p-4 text-center">
        <Timer className="h-5 w-5 text-muted-foreground" />
        <p className="text-[12px] text-muted-foreground">
          No scheduled batches. Arm one from the Hedging terminal's scheduler.
        </p>
      </div>
    )
  }

  const sorted = [...scheduled].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="p-2">
      <p className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        Batches fire from the Hedging terminal, which owns their board context.
        Cancel and Repeat work here.
      </p>
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
                ? `${entry.deploy.optionAction} ${entry.deploy.strikes.join(', ')}`
                : null
            const pending = entry.status === 'pending'
            return (
              <TableRow key={entry.id} className="h-7">
                <TableCell className="py-0.5 font-mono text-[10px]">
                  {scheduleTriggerLabel(entry.trigger)}
                </TableCell>
                <TableCell className="py-0.5 text-[10px]">
                  {label}
                  {plan && (
                    <span className="ml-1 text-muted-foreground" title="Index deploy plan">
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
    </div>
  )
}
