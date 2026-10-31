import { Bell, BellRing, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { resolveExchange } from '../lib/client-api'
import { onTicks, subscribeTicks, unsubscribeTicks } from '../lib/socket'

// ============================================================
// QuantDesk alerts — price alerts on the live tick feed.
// Arm ABOVE / BELOW a price on any symbol; when the tick crosses,
// fire a toast (once), log the hit and disarm. Rows persist in
// localStorage under `oa-quantdesk-alerts`.
// ============================================================

interface AlertRow {
  id: string
  symbol: string
  exchange: string
  condition: 'above' | 'below'
  price: number
  armed: boolean
  createdAt: number
  firedAt?: number
}

const KEY = 'oa-quantdesk-alerts'

function readRows(): AlertRow[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as AlertRow[]) : []
  } catch {
    return []
  }
}
function writeRows(rows: AlertRow[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 100)))
  } catch {
    /* ignore */
  }
}

export function QuantDeskAlerts({ activeSymbol }: { activeSymbol: string | null }) {
  const [rows, setRows] = useState<AlertRow[]>(readRows)
  const [symbol, setSymbol] = useState(activeSymbol ?? '')
  const [condition, setCondition] = useState<'above' | 'below'>('above')
  const [price, setPrice] = useState('')
  const [ltpMap, setLtpMap] = useState<Record<string, number>>({})

  // keep the default symbol following the focused chart
  useEffect(() => {
    if (activeSymbol)
      setSymbol((cur) => (cur && rows.some((r) => r.symbol === cur) ? cur : activeSymbol))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol])

  // subscribe to every armed row's symbol
  const wanted = useMemo(
    () => [...new Set(rows.filter((r) => r.armed).map((r) => r.symbol))],
    [rows]
  )
  useEffect(() => {
    if (wanted.length) subscribeTicks(wanted)
    return () => {
      if (wanted.length) unsubscribeTicks(wanted)
    }
  }, [wanted])

  useEffect(() => {
    return onTicks((map) => {
      setLtpMap((prev) => {
        let changed = false
        const next = { ...prev }
        for (const [sym, t] of Object.entries(map)) {
          if (!t || t.ltp === next[sym]) continue
          next[sym] = t.ltp
          changed = true
        }
        return changed ? next : prev
      })
    })
  }, [])

  // evaluate crossings against the latest ticks
  useEffect(() => {
    const hits: AlertRow[] = []
    for (const r of rows) {
      if (!r.armed) continue
      const ltp = ltpMap[r.symbol]
      if (ltp == null || !(ltp > 0)) continue
      if (
        (r.condition === 'above' && ltp >= r.price) ||
        (r.condition === 'below' && ltp <= r.price)
      )
        hits.push(r)
    }
    if (!hits.length) return
    const next = rows.map((r) =>
      hits.find((h) => h.id === r.id) ? { ...r, armed: false, firedAt: Date.now() } : r
    )
    setRows(next)
    writeRows(next)
    for (const h of hits) {
      toast.success(`Alert — ${h.symbol} ${h.condition} ${h.price} (LTP ${ltpMap[h.symbol]})`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ltpMap])

  const add = () => {
    const p = Number(price)
    if (!symbol.trim() || !(p > 0)) return
    const row: AlertRow = {
      id: `al${Date.now().toString(36)}`,
      symbol: symbol.trim().toUpperCase(),
      exchange: resolveExchange(symbol.trim()),
      condition,
      price: p,
      armed: true,
      createdAt: Date.now(),
    }
    const next = [row, ...rows]
    setRows(next)
    writeRows(next)
    setPrice('')
  }

  const mutate = (fn: (rows: AlertRow[]) => AlertRow[]) => {
    const next = fn(rows)
    setRows(next)
    writeRows(next)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-2 pt-2 pb-1 text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Bell className="h-3 w-3" /> Price alerts on the live feed — fire once, then disarm
      </div>
      {/* add row */}
      <div className="px-2 pb-2 flex items-center gap-1">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="Symbol"
          className="w-24 h-6 rounded bg-secondary/70 px-1.5 text-[11px] tabular outline-none focus:ring-1 ring-primary/60"
        />
        <select
          value={condition}
          onChange={(e) => setCondition(e.target.value as 'above' | 'below')}
          className="h-6 rounded bg-secondary/70 px-1 text-[11px] outline-none"
        >
          <option value="above">≥ above</option>
          <option value="below">≤ below</option>
        </select>
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="Price"
          inputMode="decimal"
          className="w-20 h-6 rounded bg-secondary/70 px-1.5 text-[11px] tabular outline-none focus:ring-1 ring-primary/60"
        />
        <button
          type="button"
          onClick={add}
          className="h-6 px-2 rounded bg-primary text-primary-foreground text-[11px] flex items-center gap-0.5"
          title="Arm the alert"
        >
          <Plus className="h-3 w-3" /> Arm
        </button>
      </div>
      {/* rows */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {rows.length === 0 && (
          <div className="text-[10px] text-muted-foreground px-1 py-2">
            No alerts yet — arm one above.
          </div>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-1.5 py-1 border-b border-border/60 text-[11px]"
          >
            {r.armed ? (
              <Bell className="h-3 w-3 text-primary shrink-0" />
            ) : (
              <BellRing className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium min-w-0 truncate flex-1">{r.symbol}</span>
            <span className="text-muted-foreground tabular">
              {r.condition === 'above' ? '≥' : '≤'} {r.price}
            </span>
            <span className="tabular text-muted-foreground w-16 text-right">
              {ltpMap[r.symbol] != null ? ltpMap[r.symbol] : '—'}
            </span>
            {r.firedAt ? (
              <span className="text-[9px] text-muted-foreground shrink-0">
                {new Date(r.firedAt).toLocaleTimeString('en-IN', { hour12: false })}
              </span>
            ) : (
              <button
                type="button"
                title={r.armed ? 'Disarm' : 'Re-arm'}
                onClick={() =>
                  mutate((rs) =>
                    rs.map((x) =>
                      x.id === r.id ? { ...x, armed: !x.armed, firedAt: undefined } : x
                    )
                  )
                }
                className={`px-1 rounded text-[9px] ${r.armed ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'}`}
              >
                {r.armed ? 'ON' : 'OFF'}
              </button>
            )}
            <button
              type="button"
              title="Delete"
              onClick={() => mutate((rs) => rs.filter((x) => x.id !== r.id))}
              className="p-0.5 rounded text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
