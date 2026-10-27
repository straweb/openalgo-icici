/**
 * The one-way tap from a deploy row's Depth button to the dock's Depth tab.
 *
 * The panel and the dock are page-level siblings with no shared parent
 * state, and wiring them through props would thread a callback through the
 * page for one job: "open the dock on this instrument's depth". A window
 * CustomEvent keeps both ends decoupled — the panel dispatches, the page
 * switches the dock to the tab and the tab adds the item. Either side can
 * be absent (the dock collapsed, the panel closed) and nothing throws.
 */

const EVENT = 'oa-trading:open-depth'

export interface DepthRequest {
  symbol: string
  exchange: string
}

/** Ask the dock for the Depth tab showing this instrument. */
export function openDepthTab(item: DepthRequest): void {
  try {
    window.dispatchEvent(new CustomEvent<DepthRequest>(EVENT, { detail: item }))
  } catch {
    // A blocked CustomEvent constructor (old embed) just means no depth tab.
  }
}

/** Subscribe on behalf of the Depth tab; returns the unsubscribe. */
export function onDepthRequest(handler: (item: DepthRequest) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DepthRequest>).detail
    if (detail?.symbol) handler({ symbol: detail.symbol, exchange: detail.exchange || 'NSE' })
  }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
