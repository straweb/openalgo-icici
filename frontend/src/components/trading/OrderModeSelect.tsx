/**
 * The global order mode's control: one select that every buy/sell reads,
 * plus the MPP percent input that shows only in MPP mode.
 *
 * Bound to `useOrderModeStore` (the theme store's pattern: zustand-persist,
 * one value for every surface — deploy panel, hedging terminal, the chart's
 * instant panel, the scheduled batches). Changing it here changes it
 * everywhere; nothing is per-surface any more.
 *
 * Two sizes, like the rest of the panel chrome: `compact` for the deploy
 * panel's footer strip (28px-scale controls), default for the settings
 * dialogs where there is room for the mode's own words.
 */

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ORDER_MODES, type OrderMode, useOrderModeStore } from '@/lib/trading/orderMode'
import { cn } from '@/lib/utils'

export function OrderModeSelect({ compact = false }: { compact?: boolean }) {
  const mode = useOrderModeStore((s) => s.mode)
  const mppPercent = useOrderModeStore((s) => s.mppPercent)
  const setMode = useOrderModeStore((s) => s.setMode)
  const setMppPercent = useOrderModeStore((s) => s.setMppPercent)
  const hint = ORDER_MODES.find((m) => m.value === mode)?.hint ?? ''

  return (
    <span className="flex items-center gap-1">
      <Select value={mode} onValueChange={(v) => setMode(v as OrderMode)}>
        <SelectTrigger
          className={cn(compact ? 'h-5 w-[70px] px-1 text-[10px]' : 'h-8 w-[110px] text-xs')}
          title={`Order mode — ${hint}`}
          aria-label="Order mode"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={compact ? 'text-[11px]' : 'text-xs'}>
          {ORDER_MODES.map((m) => (
            <SelectItem key={m.value} value={m.value} title={m.hint}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === 'mpp' && (
        <span
          className="flex items-center gap-0.5"
          title="Market protection percent: BUY buffers above the live price, SELL below"
        >
          <Input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={mppPercent}
            onChange={(e) => setMppPercent(Number(e.target.value))}
            className={cn(
              'px-1 font-mono tabular-nums',
              compact ? 'h-5 w-10 text-[10px]' : 'h-8 w-16 text-xs'
            )}
            aria-label="MPP percent"
          />
          <span
            className={
              compact ? 'text-[9px] text-muted-foreground' : 'text-xs text-muted-foreground'
            }
          >
            %
          </span>
        </span>
      )}
    </span>
  )
}
