import { describe, expect, it } from 'vitest'
import { armLadderBatch, armPastMiss, sideOfBatchAction } from './scheduleArm'
import type { ScheduledOrder } from '@/types/hedging'

describe('sideOfBatchAction', () => {
  it('reads A as CE and B as PE', () => {
    expect(sideOfBatchAction('deployA')).toBe('CE')
    expect(sideOfBatchAction('closeA')).toBe('CE')
    expect(sideOfBatchAction('deployB')).toBe('PE')
    expect(sideOfBatchAction('closeB')).toBe('PE')
  })
})

describe('armLadderBatch', () => {
  it('stamps the row for this page and names the enabled strikes', () => {
    const row = armLadderBatch(
      { action: 'deployA', trigger: { kind: 'time', at: '15:20:00', repeat: 'once' } },
      {
        underlying: 'NIFTY',
        spot: { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
        ladder: {
          ce: [
            {
              symbol: 'NIFTY28OCT2624500CE',
              exchange: 'NFO',
              kind: 'option',
              strike: 24500,
              optionType: 'CE',
              lotSize: 75,
              enabled: true,
              lots: 0,
              weight: 100,
              entry: null,
              target: null,
              stoploss: null,
            },
          ],
          pe: [],
        },
      }
    )
    expect(row.origin).toBe('trading')
    expect(row.modeAtCreation).toBe('fno')
    expect(row.deploy?.side).toBe('CE')
    expect(row.deploy?.strikes).toEqual([24500])
    expect(row.deploy?.optionAction).toBe('BUY')
    expect(row.deploy?.exchange).toBe('NFO')
    expect(row.deploy?.spot).toEqual({ symbol: 'NIFTY', exchange: 'NSE_INDEX' })
  })

  it('records no strikes for exit-all — the sweep reads the ladder at fire time', () => {
    const row = armLadderBatch(
      { action: 'exitAll', trigger: { kind: 'time', at: '15:29:00', repeat: 'daily' } },
      { underlying: 'NIFTY', spot: null }
    )
    expect(row.deploy?.strikes).toEqual([])
  })

  it('a once entry whose time passed retires as missed', () => {
    const row = armLadderBatch(
      { action: 'deployA', trigger: { kind: 'time', at: '00:00:01', repeat: 'once' } },
      { underlying: 'NIFTY', spot: null }
    )
    expect(row.status).toBe('missed')
    expect(armPastMiss(row)).toBe('missed')
  })

  it('a daily entry whose time passed waits for the next trading day', () => {
    const row = armLadderBatch(
      { action: 'deployA', trigger: { kind: 'time', at: '00:00:01', repeat: 'daily' } },
      { underlying: 'NIFTY', spot: null }
    )
    expect(row.status).toBe('pending')
    expect(armPastMiss(row)).toBe('daily')
  })

  it('a fresh pending row reads as not-past', () => {
    const row = armLadderBatch(
      { action: 'deployA', trigger: { kind: 'time', at: '23:59:59', repeat: 'once' } },
      { underlying: 'NIFTY', spot: null }
    )
    expect(row.status).toBe('pending')
    expect(armPastMiss(row)).toBeNull()
  })

  it('price triggers pass through untouched', () => {
    const row = armLadderBatch(
      {
        action: 'deployB',
        trigger: { kind: 'price', symbol: 'NIFTY', exchange: 'NSE_INDEX', condition: 'above', price: 25000 },
      },
      { underlying: 'NIFTY', spot: null }
    )
    expect(row.status).toBe('pending')
    expect(row.deploy?.side).toBe('PE')
    expect((row as ScheduledOrder).trigger).toMatchObject({ kind: 'price', price: 25000 })
  })
})
