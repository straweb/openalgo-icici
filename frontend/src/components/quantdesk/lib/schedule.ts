// ============================================================
// QuantDesk scheduled level-deploys.
//
// The action bar's Schedule popover arms a CE/PE level deploy for a
// clock time (IST, once or daily). Rows live in their own persisted
// store (`oa-quantdesk-schedule`), separate from the hedging page's
// shared scheduler book — quantdesk rows fire through
// useQuantdeskScheduler() in the page, placing the same
// capital-sized option orders the Deploy-by-level button places.
// ============================================================

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type QdScheduleAction = 'BUY_CE' | 'BUY_PE' | 'SELL_CE' | 'SELL_PE'
export type QdScheduleLevel =
  | 'ITM5'
  | 'ITM4'
  | 'ITM3'
  | 'ITM2'
  | 'ITM1'
  | 'ATM'
  | 'OTM1'
  | 'OTM2'
  | 'OTM3'
  | 'OTM4'
  | 'OTM5'

export interface QdScheduleRow {
  id: string
  underlying: string
  action: QdScheduleAction
  level: QdScheduleLevel
  /** 'HH:MM' IST, 24h */
  time: string
  repeatDaily: boolean
  /** 'PCT' = % of session capital (lotsPct), 'LOT' = fixed lots (lots) */
  sizing: 'PCT' | 'LOT'
  lots: number
  allocPct: number
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  productType: 'MIS' | 'NRML' | 'CNC'
  status: 'pending' | 'done' | 'missed' | 'cancelled'
  createdAt: number
  firedAt?: number
  message?: string
}

interface QdScheduleState {
  rows: QdScheduleRow[]
  add: (row: QdScheduleRow) => void
  cancel: (id: string) => void
  markDone: (id: string, message: string) => void
  markMissed: (id: string, message: string) => void
  remove: (id: string) => void
  clearFinished: () => void
}

export const useQdSchedule = create<QdScheduleState>()(
  persist(
    (set, get) => ({
      rows: [],
      add: (row) => set({ rows: [row, ...get().rows].slice(0, 200) }),
      cancel: (id) =>
        set({
          rows: get().rows.map((r) =>
            r.id === id && r.status === 'pending' ? { ...r, status: 'cancelled' } : r
          ),
        }),
      markDone: (id, message) =>
        set({
          rows: get().rows.map((r) =>
            r.id === id ? { ...r, status: 'done', firedAt: Date.now(), message } : r
          ),
        }),
      markMissed: (id, message) =>
        set({
          rows: get().rows.map((r) =>
            r.id === id ? { ...r, status: 'missed', firedAt: Date.now(), message } : r
          ),
        }),
      remove: (id) => set({ rows: get().rows.filter((r) => r.id !== id) }),
      clearFinished: () => set({ rows: get().rows.filter((r) => r.status === 'pending') }),
    }),
    { name: 'oa-quantdesk-schedule', version: 1 }
  )
)

/** IST wall clock parts (hours, minutes, seconds, y/m/d) from a Date. */
export function istPartsOf(d: Date): {
  h: number
  m: number
  s: number
  y: number
  mo: number
  d: number
} {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >
  return {
    h: Number(p.hour) % 24,
    m: Number(p.minute),
    s: Number(p.second),
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
  }
}

/** Seconds until the next occurrence of 'HH:MM' IST (>=0). */
export function istSecondsUntil(time: string, now = new Date()): number {
  const [hh, mm] = time.split(':').map((x) => Number(x) || 0)
  const cur = istPartsOf(now)
  const curSecs = cur.h * 3600 + cur.m * 60 + cur.s
  const tgt = hh * 3600 + mm * 60
  return tgt - curSecs
}
