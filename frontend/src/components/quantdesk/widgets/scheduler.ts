import { useEffect } from 'react'
import { toast } from 'sonner'
import { api, resolveExchange, sideStrikeFor } from '../lib/client-api'
import { istSecondsUntil, type QdScheduleRow, useQdSchedule } from '../lib/schedule'

// Fires armed quantdesk schedule rows (clock trigger, IST). Runs inside
// the page so rows fire while any tab is open — the same deal the
// hedging terminal's engine offers its own book.

let firing = false

async function fireRow(row: QdScheduleRow) {
  const side = row.action.startsWith('BUY') ? 'BUY' : 'SELL'
  const type: 'CE' | 'PE' = row.action.endsWith('CE') ? 'CE' : 'PE'
  try {
    const chain = await api.optionChain(row.underlying, null, [])
    const meta = chain.meta
    if (!meta || !meta.atm) throw new Error(`no chain for ${row.underlying}`)
    const dir: -1 | 0 | 1 = row.level === 'ATM' ? 0 : row.level.startsWith('ITM') ? -1 : 1
    const n = row.level === 'ATM' ? 0 : Number(row.level.slice(3)) || 0
    const strike = sideStrikeFor({ ce: meta.ceAtm, pe: meta.peAtm }, meta.step, dir, n, type)
    const strikeRow = chain.rows.find((r) => r.strike === strike)
    const cell = strikeRow ? (type === 'CE' ? strikeRow.ce : strikeRow.pe) : null
    if (!cell?.exists) throw new Error(`${type} ${strike} not available`)
    const res = await api.placeOrder({
      symbol: cell.symbol,
      exchange: resolveExchange(cell.symbol),
      side,
      qty: row.sizing === 'LOT' ? row.lots : 0,
      ...(row.sizing === 'PCT' ? { capitalPct: row.allocPct } : {}),
      orderType: row.orderType,
      productType: row.productType,
      source: 'STRATEGY',
      tag: `sched:${row.level}`,
    })
    const filled = res.legs.filter((l) => l.status === 'FILLED').length
    const msg = `${side} ${row.underlying} ${row.level} ${type} — ${cell.symbol}${filled ? ` · ${filled} filled` : ''}`
    if (res.status === 'FAILED') throw new Error(res.message || 'order rejected')
    useQdSchedule.getState().markDone(row.id, msg)
    toast.success(`Scheduled deploy fired — ${msg}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'scheduled deploy failed'
    useQdSchedule.getState().markMissed(row.id, msg)
    toast.error(`Scheduled deploy missed — ${msg}`)
  }
}

export function useQuantdeskScheduler() {
  const rows = useQdSchedule((s) => s.rows)
  useEffect(() => {
    const pending = rows.filter((r) => r.status === 'pending')
    if (!pending.length) return
    const iv = setInterval(() => {
      if (firing) return
      const now = new Date()
      const firedDay = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      for (const row of useQdSchedule.getState().rows) {
        if (row.status !== 'pending') continue
        const secs = istSecondsUntil(row.time, now)
        if (secs > -3600 && secs <= 0) {
          // inside the fire window
          const lastDay = row.firedAt
            ? new Date(row.firedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
            : null
          if (lastDay === firedDay) continue
          firing = true
          void fireRow(row).finally(() => {
            firing = false
            if (!row.repeatDaily) useQdSchedule.getState().markDone(row.id, 'fired')
          })
          break // one per tick
        }
        if (secs <= -3600) {
          // window missed entirely (app was closed) — retire one-shot rows
          if (!row.repeatDaily)
            useQdSchedule.getState().markMissed(row.id, `window passed (${row.time} IST)`)
        }
      }
    }, 1000)
    return () => clearInterval(iv)
  }, [rows])
}
