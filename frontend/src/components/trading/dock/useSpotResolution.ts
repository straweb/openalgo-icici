import { useCallback, useEffect, useState } from 'react'
import { optionChainApi } from '@/api/option-chain'
import { scalpingApi } from '@/api/scalping'
import { fnoExchangeFor } from '@/types/hedging'
import type { OptionChainResponse } from '@/types/option-chain'

/**
 * The charted underlying's option chain snapshot, read once per symbol —
 * the one fetch both dock tabs build on: the Scheduled popup defaults its
 * price triggers to the spot quote target it resolves, the Index tab
 * anchors its level deploy on the ATM and strike interval it carries.
 *
 * `strikeCount` trades breadth for speed: the default five strikes answer
 * "what is the spot quote target", while a level deploy wants the ladder
 * around it and asks for more. Errors surface as `error` so a tab can say
 * why it is empty instead of spinning.
 */
export function useSpotResolution(
  apiKey: string,
  activeSymbol: string | null,
  strikeCount = 5,
  /** The underlying's cash exchange; the FNO side follows from it. */
  exchange = 'NSE'
) {
  const [chain, setChain] = useState<OptionChainResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeSymbol) return
    const optionsExchange = fnoExchangeFor(exchange)
    try {
      const expiries = await scalpingApi.getExpiry(activeSymbol, optionsExchange, 'options')
      const expiry = (expiries.data ?? [])[0]
      if (!expiry) {
        setError(`${activeSymbol} has no option chain to resolve the spot quote from`)
        setChain(null)
        return
      }
      const res = await optionChainApi.getOptionChain(
        apiKey,
        activeSymbol,
        optionsExchange,
        expiry,
        strikeCount
      )
      if (res.status === 'success' && res.underlying_symbol) {
        setChain(res)
        setError(null)
      } else {
        setChain(null)
        setError(res.message || 'Chain snapshot unavailable')
      }
    } catch {
      setChain(null)
      setError('Chain snapshot unavailable')
    }
  }, [apiKey, activeSymbol, strikeCount, exchange])

  useEffect(() => {
    setChain(null)
    setError(null)
    void load()
  }, [load])

  const spot = chain
    ? {
        symbol: chain.underlying_symbol,
        exchange: chain.underlying_exchange ?? fnoExchangeFor(exchange),
      }
    : null
  return { chain, spot, error }
}
