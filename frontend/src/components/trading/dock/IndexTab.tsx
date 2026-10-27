/**
 * The Index tab, from the charting terminal: the hedging terminal's
 * constituent breakdown, following the charted underlying.
 *
 * The IndexPanel fetches its own constituents and quotes; it needs the
 * underlying, the spot quote target the chain snapshot resolves, and a way
 * to load a row into the focused pane. The snapshot is fetched once per
 * charted symbol, exactly the way the hedging page builds its dock's
 * indexSpot.
 */

import { useCallback, useEffect, useState } from 'react'
import { optionChainApi } from '@/api/option-chain'
import { scalpingApi } from '@/api/scalping'
import { IndexPanel } from '@/components/hedging/IndexPanel'
import type { SearchRow } from '@/lib/trading/terminal'
import { fnoExchangeFor } from '@/types/hedging'

interface Props {
  apiKey: string
  /** The focused pane's symbol — the underlying whose constituents show. */
  activeSymbol: string | null
  /** Charts a row in the focused pane, the way a watchlist row does. */
  onPick(row: SearchRow): void
}

export function IndexTab({ apiKey, activeSymbol, onPick }: Props) {
  const [spot, setSpot] = useState<{ symbol: string; exchange: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSpot = useCallback(async () => {
    if (!activeSymbol) return
    const exchange = fnoExchangeFor('NSE')
    try {
      const expiries = await scalpingApi.getExpiry(activeSymbol, exchange, 'options')
      const expiry = (expiries.data ?? [])[0]
      if (!expiry) {
        setError(`${activeSymbol} has no option chain to resolve the spot quote from`)
        setSpot(null)
        return
      }
      const res = await optionChainApi.getOptionChain(
        apiKey,
        activeSymbol,
        exchange,
        expiry,
        5
      )
      if (res.status === 'success' && res.underlying_symbol) {
        setSpot({ symbol: res.underlying_symbol, exchange: res.underlying_exchange ?? exchange })
        setError(null)
      } else {
        setSpot(null)
        setError(res.message || 'Chain snapshot unavailable')
      }
    } catch {
      setSpot(null)
      setError('Chain snapshot unavailable')
    }
  }, [apiKey, activeSymbol])

  useEffect(() => {
    setSpot(null)
    setError(null)
    void loadSpot()
  }, [loadSpot])

  if (!activeSymbol) {
    return (
      <p className="p-4 text-center text-[12px] text-muted-foreground">
        Chart an underlying to break it into its constituents.
      </p>
    )
  }
  if (error && !spot) {
    return <p className="p-4 text-center text-[12px] text-muted-foreground">{error}</p>
  }

  return (
    <div className="h-full min-h-0">
      <IndexPanel
        underlying={activeSymbol}
        indexSpot={spot}
        onLoadChart={(pick) => onPick({ symbol: pick.symbol, exchange: pick.exchange, name: pick.name })}
      />
    </div>
  )
}
