'use client'

import { useQuery } from '@tanstack/react-query'
import { CanvasChart } from '../chart/canvas-chart'
import { api, fmtMoney } from '../lib/client-api'
import { useTerminal } from '../lib/store'
import { mergeChain, type SyncChainResp, useSyncData } from '../lib/sync'

// ============================================================
// Spot-chart companion strip for F&O underlyings:
// default-open ATM strike charts — CE on the left, PE on the
// right, under the main spot chart. Reuses the from-scratch
// canvas chart in compact (mini) mode; follows the live ATM
// (re-keys automatically when spot crosses a strike step).
//
// Round 49: the ATM quotes + chain meta ride the 1s sync:chain
// PUSH (the server already builds and broadcasts the chain every
// second for subscribed underlyings). The old REST poll at 2s
// built the ENTIRE chain server-side twice a second per mini
// strip — one of the "n duplicate api calls" that piled the REST
// plane up with pending quotes/candles. REST is now only an
// 8s fallback until the first push arrives.
// ============================================================

export function OptionMiniCharts({ underlying }: { underlying: string }) {
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    (d) => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === underlying,
    underlying ? { chains: [{ underlying, expiry: null }] } : undefined
  )
  // REST fallback ONLY until the first push lands (or when pushes stop) —
  // 8s, same cadence the strikes desk uses for its own backup
  const { data: chainRest } = useQuery({
    queryKey: ['optionChainMinis', underlying],
    queryFn: () => api.optionChain(underlying, null, []),
    enabled: !!underlying,
    refetchInterval: 8000,
  })
  const data = mergeChain(chainSync, chainRest)

  const meta = data?.meta ?? null
  // side-ATM cells straight off the chain payload (CE=floor ATM, PE=ceil ATM)
  const ceCell = data?.atmCe ?? null
  const peCell = data?.atmPe ?? null

  const setSelectedSymbol = useTerminal((s) => s.setSymbol)

  if (!meta || (!ceCell && !peCell)) {
    return (
      <div className="h-[132px] shrink-0 border-t border-border flex items-center justify-center text-[10px] text-muted-foreground">
        Loading ATM CE/PE…
      </div>
    )
  }

  const cellColor = (c?: { ltp: number; prevClose: number } | null) =>
    c && c.ltp >= c.prevClose ? 'term-up' : 'term-down'

  return (
    <div
      className="h-[132px] shrink-0 border-t border-border grid grid-cols-2 gap-px bg-border/60"
      data-option-minis
    >
      {[
        { label: 'CE', cell: ceCell, tint: '#00c896' },
        { label: 'PE', cell: peCell, tint: '#ff4d5e' },
      ].map(({ label, cell, tint }) => (
        <div key={label} className="bg-card flex flex-col min-w-0">
          <button
            onClick={() => cell?.exists && setSelectedSymbol(cell.symbol)}
            className="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9px] hover:bg-accent/60 transition-colors text-left"
            title="Click to load this option in the main chart + order pad"
          >
            <span className="font-bold" style={{ color: tint }}>
              {meta.atm} {label}
            </span>
            <span className="text-muted-foreground truncate px-1">
              {meta.underlying} · {meta.expiry} · L{meta.lotSize}
            </span>
            <span className={`tabular font-bold ${cellColor(cell)}`}>
              {cell?.exists ? fmtMoney(cell.ltp) : '—'}
              {cell?.exists ? (
                <span className={cell.changePct >= 0 ? 'term-up' : 'term-down'}>
                  {' '}
                  {cell.changePct >= 0 ? '+' : ''}
                  {cell.changePct.toFixed(1)}%
                </span>
              ) : null}
            </span>
          </button>
          <div className="flex-1 min-h-0">
            {cell?.exists ? (
              <CanvasChart
                symbol={cell.symbol}
                tf="1m"
                chartType="candles"
                showVolume={false}
                showSMA20={false}
                showSMA50={false}
                height="h-full"
                mini
              />
            ) : (
              <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground">
                ATM {label} contract unavailable
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
