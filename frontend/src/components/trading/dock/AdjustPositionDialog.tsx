/**
 * One dialog for the three ways a position row changes size.
 *
 * **Add** buys (or shorts) more in the net direction; **Reduce** places the
 * opposite side for a part of the position, with quarter/half/three-quarter
 * chips for the lazy close; **Reopen** — a closed row's Repeat — asks which
 * side to re-enter, because a zero row no longer remembers one. All three go
 * out as market orders through the same wire the row's Repeat has always
 * used: the books refresh after, and the fill shows up as its own row.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { DockPosition } from './blotter'
import { signedQty } from './format'

export type PositionAdjustKind = 'add' | 'reduce' | 'reopen'

const PCT_CHIPS = [25, 50, 75, 100] as const

interface Props {
  position: DockPosition | null
  kind: PositionAdjustKind | null
  onConfirm(position: DockPosition, action: 'BUY' | 'SELL', quantity: number): void
  onOpenChange(open: boolean): void
}

export function AdjustPositionDialog({ position, kind, onConfirm, onOpenChange }: Props) {
  const open = position != null && kind != null
  const net = Math.abs(position?.quantity ?? 0)
  const long = (position?.quantity ?? 0) >= 0
  const step = position?.lot_size && position.lot_size > 0 ? position.lot_size : 1
  const [qty, setQty] = useState(0)
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')

  // Each open re-seeds: Add suggests adding the position's own size again,
  // Reduce starts at half, Reopen at one step of whatever it closed with.
  // The seeds depend on the row and the kind, not on anything else mutable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed per row+kind
  useEffect(() => {
    if (!open || !position) return
    if (kind === 'add') setQty(net || step)
    else if (kind === 'reduce') setQty(Math.max(step, Math.round(net / 2)))
    else setQty(step)
    setSide(kind === 'reopen' ? 'BUY' : long ? 'BUY' : 'SELL')
  }, [position, kind, open])

  if (!position || !kind) return null

  const action: 'BUY' | 'SELL' =
    kind === 'reduce' ? (long ? 'SELL' : 'BUY') : kind === 'reopen' ? side : long ? 'BUY' : 'SELL'
  const valid = qty > 0 && (kind !== 'reduce' || qty <= net)
  const title =
    kind === 'add'
      ? `Add to ${position.symbol}`
      : kind === 'reduce'
        ? `Reduce ${position.symbol}`
        : `Re-enter ${position.symbol}`
  const verb = action === 'BUY' ? 'Buy' : 'Sell'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-4">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-[11px]">
            {kind === 'add' &&
              `${verb} more into the net ${long ? 'long' : 'short'} ${signedQty(position.quantity)} ${position.product} position, at the market.`}
            {kind === 'reduce' &&
              `${verb} part of the net ${signedQty(position.quantity)} ${position.product} position, at the market. What is left stays open.`}
            {kind === 'reopen' &&
              `The row is flat — pick the side and size to re-enter on ${position.exchange}, at the market.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {kind === 'reopen' && (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                className={cn(
                  'h-7 flex-1 text-[11px]',
                  side === 'BUY' && 'bg-emerald-600 text-white hover:bg-emerald-700'
                )}
                variant={side === 'BUY' ? 'default' : 'outline'}
                onClick={() => setSide('BUY')}
              >
                Buy
              </Button>
              <Button
                type="button"
                size="sm"
                className={cn(
                  'h-7 flex-1 text-[11px]',
                  side === 'SELL' && 'bg-red-600 text-white hover:bg-red-700'
                )}
                variant={side === 'SELL' ? 'default' : 'outline'}
                onClick={() => setSide('SELL')}
              >
                Sell
              </Button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-8 px-0 text-[12px]"
              aria-label="Less"
              onClick={() => setQty((value) => Math.max(0, value - step))}
            >
              −
            </Button>
            <Input
              type="number"
              min={0}
              value={qty || ''}
              onChange={(event) => setQty(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
              aria-label="Quantity"
              className="h-7 text-center text-[12px]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-8 px-0 text-[12px]"
              aria-label="More"
              onClick={() => setQty((value) => value + step)}
            >
              +
            </Button>
          </div>
          {kind === 'reduce' && net > 0 && (
            <div className="flex items-center gap-1">
              {PCT_CHIPS.map((pct) => (
                <Button
                  key={pct}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 flex-1 px-1 text-[10px]"
                  onClick={() =>
                    setQty(Math.max(step, Math.round((net * pct) / 100 / step) * step))
                  }
                >
                  {pct === 100 ? 'All' : `${pct}%`}
                </Button>
              ))}
            </div>
          )}
          {kind === 'reduce' && qty > net && (
            <p className="text-[10px] text-destructive">
              More than the position holds — Reduce closes at most {net}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!valid}
            className={cn(
              action === 'BUY'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-red-600 hover:bg-red-700',
              'text-white'
            )}
            onClick={() => {
              if (!valid) return
              onConfirm(position, action, qty)
              onOpenChange(false)
            }}
          >
            {verb} {qty || 0}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
