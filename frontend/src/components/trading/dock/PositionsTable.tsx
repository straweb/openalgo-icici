/**
 * The position book as a dock table. One row per (symbol, exchange, product),
 * so an MIS and an NRML position in the same contract are two rows, and the
 * zero-quantity rows the broker still reports stay visible with their
 * realised figure — and a Repeat of their own, side picked in the dialog.
 *
 * Close is per row, through the web route that squares off one position.
 * Add and Reduce sit beside it: a position is not only entered and flattened
 * whole — the trader scales in and scales out, and the dialog's quantity
 * stepper (percent chips on a reduce) keeps that to one press each. The
 * endpoint that squares off everything is behind the header's Close all and
 * nowhere near a row button.
 */

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { SearchRow } from '@/lib/trading/terminal'
import { cn } from '@/lib/utils'
import { useOneClickStore } from '@/stores/oneClickStore'
import { AdjustPositionDialog, type PositionAdjustKind } from './AdjustPositionDialog'
import { type DockPosition, positionKey } from './blotter'
import {
  EmptyRows,
  isActiveRow,
  isRowClick,
  ROW,
  ROW_ACTIVE,
  SymbolCell,
  TD,
  TD_NUM,
  TH,
  TH_NUM,
  toneClass,
} from './cells'
import { fmt2, signed, signedQty } from './format'

interface Props {
  positions: DockPosition[]
  activeSymbol?: string | null
  onPick(row: SearchRow): void
  /** Confirmed by the user; the caller places the square-off. */
  onClose(position: DockPosition): void
  /** Re-enter the position's side and quantity as a fresh market order. */
  onRepeat(position: DockPosition): void
  /**
   * Scale the position: add in the net direction, reduce part of it, or
   * re-enter a flat row on the dialog's chosen side. The caller places the
   * market order and refreshes the books.
   */
  onAdjust(position: DockPosition, action: 'BUY' | 'SELL', quantity: number): void
  isLoading?: boolean
}

export function PositionsTable({
  positions,
  activeSymbol,
  onPick,
  onClose,
  onRepeat,
  onAdjust,
  isLoading,
}: Props) {
  const [pending, setPending] = useState<DockPosition | null>(null)
  /** The row a size dialog is open for, and which way it is scaling. */
  const [adjusting, setAdjusting] = useState<{
    position: DockPosition
    kind: PositionAdjustKind
  } | null>(null)
  // One-Click armed, Close lands on the first press — the trader has said
  // the click is the order, and a row's Close is the most deliberate click
  // there is. The dialog stays for the disarmed path.
  const armed = useOneClickStore((s) => s.armed)

  const requestClose = (p: DockPosition) => {
    if (armed) onClose(p)
    else setPending(p)
  }

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Symbol
            </th>
            <th scope="col" className={TH}>
              Exch
            </th>
            <th scope="col" className={TH}>
              Product
            </th>
            <th scope="col" className={TH_NUM}>
              Net qty
            </th>
            <th scope="col" className={TH_NUM}>
              Avg
            </th>
            <th scope="col" className={TH_NUM}>
              LTP
            </th>
            <th scope="col" className={TH_NUM}>
              P&amp;L
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 && (
            <EmptyRows colSpan={8}>{isLoading ? 'Loading positions' : 'No positions.'}</EmptyRows>
          )}
          {positions.map((p) => {
            const active = isActiveRow(activeSymbol, p)
            const open = p.quantity !== 0
            return (
              <tr
                key={positionKey(p)}
                className={cn(ROW, active && ROW_ACTIVE, !open && 'text-muted-foreground')}
                onClick={(e) => {
                  if (isRowClick(e)) onPick({ symbol: p.symbol, exchange: p.exchange })
                }}
              >
                <SymbolCell
                  symbol={p.symbol}
                  exchange={p.exchange}
                  active={active}
                  onPick={onPick}
                />
                <td className={cn(TD, 'text-muted-foreground')}>{p.exchange}</td>
                <td className={cn(TD, 'text-muted-foreground')}>{p.product}</td>
                <td className={cn(TD_NUM, 'font-medium', open && toneClass(p.quantity))}>
                  {signedQty(p.quantity)}
                </td>
                <td className={TD_NUM}>{fmt2(p.average_price)}</td>
                <td className={TD_NUM}>{p.ltp ? fmt2(p.ltp) : '-'}</td>
                <td className={cn(TD_NUM, 'font-medium', toneClass(p.pnl))}>{signed(p.pnl)}</td>
                <td className={cn(TD, 'text-right')}>
                  <span className="inline-flex gap-1">
                    {open ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px] text-emerald-700 hover:text-emerald-700 dark:text-emerald-400"
                          onClick={() => setAdjusting({ position: p, kind: 'add' })}
                          aria-label={`Add to ${p.product} position in ${p.symbol}`}
                        >
                          Add
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px] text-amber-700 hover:text-amber-700 dark:text-amber-400"
                          onClick={() => setAdjusting({ position: p, kind: 'reduce' })}
                          aria-label={`Reduce ${p.product} position in ${p.symbol}`}
                        >
                          Reduce
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => onRepeat(p)}
                          aria-label={`Repeat ${p.product} position in ${p.symbol}`}
                        >
                          Repeat
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px] text-rose-600 hover:text-rose-600 dark:text-rose-400"
                          onClick={() => requestClose(p)}
                          aria-label={`Close ${p.product} position in ${p.symbol}`}
                        >
                          Close
                        </Button>
                      </>
                    ) : (
                      // A flat row has no side to remember, so its Repeat asks:
                      // the dialog picks side and size, then re-enters at market.
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setAdjusting({ position: p, kind: 'reopen' })}
                        aria-label={`Re-enter ${p.product} in ${p.symbol}`}
                      >
                        Repeat
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <AdjustPositionDialog
        position={adjusting?.position ?? null}
        kind={adjusting?.kind ?? null}
        onConfirm={(position, action, quantity) => onAdjust(position, action, quantity)}
        onOpenChange={(value) => !value && setAdjusting(null)}
      />

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {pending?.symbol}?</AlertDialogTitle>
            <AlertDialogDescription>
              Places a market order on the opposite side for the net{' '}
              {pending ? signedQty(pending.quantity) : ''} {pending?.product} position on{' '}
              {pending?.exchange}. Only this position is squared off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) onClose(pending)
                setPending(null)
              }}
            >
              Close position
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
