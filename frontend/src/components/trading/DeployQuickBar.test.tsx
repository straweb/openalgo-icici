import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDeployState } from '@/lib/trading/deployPlan'
import { cleanup, fireEvent, render, waitFor } from '@/test/test-utils'
import { DeployQuickBar } from './DeployQuickBar'

afterEach(cleanup)

/**
 * The bar reads the persisted deploy book at mount and on a slow stride, so
 * a test seeds the book through the same write the panel uses: one bound
 * index underlying, one enabled row per side, manual lots so the sizing
 * arithmetic never has to trust a funds snapshot.
 */
const CE_ROW = {
  symbol: 'NIFTY28OCT2625500CE',
  exchange: 'NFO',
  kind: 'option' as const,
  strike: 25500,
  optionType: 'CE' as const,
  lotSize: 75,
  enabled: true,
  lots: 1,
  weight: 100,
  entry: null,
  target: null,
  stoploss: null,
}
const PE_ROW = {
  ...CE_ROW,
  symbol: 'NIFTY28OCT2625500PE',
  strike: 25500,
  optionType: 'PE' as const,
}

const { tradingApi } = vi.hoisted(() => ({
  tradingApi: {
    getMultiQuotes: vi.fn(),
    getPositions: vi.fn(),
    getFunds: vi.fn(),
    placeOrder: vi.fn(),
  },
}))

vi.mock('@/api/trading', () => ({ tradingApi }))

function freshBook() {
  return {
    books: {
      'NFO:NIFTY': { ce: [CE_ROW], pe: [PE_ROW] },
    },
    stocks: [],
    product: 'MIS' as const,
    pricetype: 'MARKET' as const,
    lots: 1,
    capitalSource: 'percent' as const,
    capitalFixed: 0,
    capitalPercent: 100,
    capitalBasis: 'initial' as const,
    brackets: [],
    workspace: { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
  }
}

beforeEach(() => {
  window.localStorage.clear()
  writeDeployState(freshBook())
  tradingApi.getMultiQuotes.mockResolvedValue({
    status: 'success',
    results: [
      { symbol: CE_ROW.symbol, data: { ltp: 120 } },
      { symbol: PE_ROW.symbol, data: { ltp: 95 } },
    ],
  })
  tradingApi.getPositions.mockResolvedValue({ status: 'success', data: [] })
  tradingApi.getFunds.mockResolvedValue({ status: 'success', data: { availablecash: '100000' } })
  tradingApi.placeOrder.mockResolvedValue({ status: 'success', orderid: '1' })
})

describe('DeployQuickBar', () => {
  it('opens the rail Strategy panel from its Strategy bots button', () => {
    const onOpenStrategy = vi.fn()
    const view = render(
      <DeployQuickBar apiKey="k" refuse={() => false} onOpenStrategy={onOpenStrategy} />
    )
    fireEvent.click(view.getByRole('button', { name: /strategy bots/i }))
    expect(onOpenStrategy).toHaveBeenCalledTimes(1)
  })

  it('carries the panel second row: Schedule, Deploy by level, product and order mode', () => {
    const view = render(
      <DeployQuickBar apiKey="k" refuse={() => false} onOpenStrategy={() => {}} />
    )
    expect(view.getByRole('button', { name: /schedule/i })).toBeEnabled()
    expect(view.getByRole('button', { name: /deploy by level/i })).toBeEnabled()
    expect(view.getByLabelText('Product')).toHaveTextContent('MIS')
    expect(view.getByLabelText('Order mode')).toBeInTheDocument()
  })

  it('carries the two swaps beside the deploys and closes', () => {
    const view = render(
      <DeployQuickBar apiKey="k" refuse={() => false} onOpenStrategy={() => {}} />
    )
    expect(view.getByRole('button', { name: 'CE→PE' })).toBeEnabled()
    expect(view.getByRole('button', { name: 'PE→CE' })).toBeEnabled()
  })

  it('swaps CE for PE: the leaving side sells first, the entering side buys after', async () => {
    const view = render(
      <DeployQuickBar apiKey="k" refuse={() => false} onOpenStrategy={() => {}} />
    )
    fireEvent.click(view.getByRole('button', { name: 'CE→PE' }))
    await waitFor(() => expect(tradingApi.placeOrder).toHaveBeenCalledTimes(2))
    const [leave, enter] = tradingApi.placeOrder.mock.calls.map((call) => call[0])
    expect(leave).toMatchObject({ symbol: CE_ROW.symbol, action: 'SELL', quantity: 75 })
    expect(enter).toMatchObject({
      symbol: PE_ROW.symbol,
      action: 'BUY',
      quantity: 75,
      product: 'MIS',
    })
  })
})
