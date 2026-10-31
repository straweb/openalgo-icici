import { useQuery } from '@tanstack/react-query'
import { CalendarClock, ChevronDown, Clock, Layers, Settings2, Trash2, Wallet } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, fmtInr, resolveExchange, sideStrikeFor } from '../lib/client-api'
import { type QdScheduleAction, type QdScheduleLevel, useQdSchedule } from '../lib/schedule'
import { useTerminal, type WorkspaceCfg } from '../lib/store'
import {
  mergeChain,
  type SyncChainResp,
  type SyncCore,
  useSyncChannel,
  useSyncData,
} from '../lib/sync'
import { StrikeActions } from '../panels/strikes-panel'

// ============================================================
// Action bar — full width above the bottom dock:
//   [session capital] [order settings] [quick deploy (strikes desk)]
//   [deploy by level + schedule]
// ============================================================

const LEVELS: QdScheduleLevel[] = [
  'ITM5',
  'ITM4',
  'ITM3',
  'ITM2',
  'ITM1',
  'ATM',
  'OTM1',
  'OTM2',
  'OTM3',
  'OTM4',
  'OTM5',
]

export function ActionBar({ ws, apiKey }: { ws: WorkspaceCfg; apiKey: string }) {
  return (
    <div className="flex items-center gap-2 px-2 h-10 border-y border-border bg-card/60 overflow-x-auto shrink-0">
      <SessionCapital />
      <span className="w-px h-5 bg-border shrink-0" />
      <OrderSettings />
      <span className="w-px h-5 bg-border shrink-0" />
      {/* quick deploy — the strikes desk deploy bar, verbatim from the port */}
      <div className="flex items-center min-w-0">
        <StrikeActions ws={ws} />
      </div>
      <span className="w-px h-5 bg-border shrink-0" />
      <LevelDeploy ws={ws} apiKey={apiKey} />
    </div>
  )
}

// ---- session capital ------------------------------------------

function SessionCapital() {
  const core = useSyncChannel<SyncCore>('sync:core')
  const cash = core?.funds?.[0]?.cash
  const net = core?.session?.net
  return (
    <div
      className="flex items-center gap-2 shrink-0"
      title="Session capital (available cash) and net P&L (realized + unrealized)"
    >
      <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
      <div className="leading-none">
        <div className="text-[8px] uppercase text-muted-foreground">Capital</div>
        <div className="text-[11px] font-medium tabular">
          {cash != null ? fmtInr(cash, 0) : '—'}
        </div>
      </div>
      <div className="leading-none">
        <div className="text-[8px] uppercase text-muted-foreground">Net P&L</div>
        <div
          className={`text-[11px] font-medium tabular ${net == null ? '' : net >= 0 ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}
        >
          {net != null ? fmtInr(net, 0) : '—'}
        </div>
      </div>
    </div>
  )
}

// ---- order settings -------------------------------------------

function OrderSettings() {
  const side = useTerminal((s) => s.side)
  const setSide = useTerminal((s) => s.setSide)
  const orderType = useTerminal((s) => s.orderType)
  const setOrderType = useTerminal((s) => s.setOrderType)
  const productType = useTerminal((s) => s.productType)
  const setProductType = useTerminal((s) => s.setProductType)
  const qty = useTerminal((s) => s.qty)
  const setQty = useTerminal((s) => s.setQty)
  const qtyMode = useTerminal((s) => s.qtyMode)
  const setQtyMode = useTerminal((s) => s.setQtyMode)
  const limitPrice = useTerminal((s) => s.limitPrice)
  const setLimitPrice = useTerminal((s) => s.setLimitPrice)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary/70 hover:bg-secondary text-[10px]"
        title="Order settings — side, product, order type, quantity and qty mode (shared with the charts and panels)"
      >
        <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className={`tabular ${side === 'BUY' ? 'text-[#00c896]' : 'text-[#ff4d5e]'}`}>
          {side}
        </span>
        <span className="text-muted-foreground tabular">
          {productType} · {orderType}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg p-2 text-[11px]">
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Side</span>
              <div className="flex rounded overflow-hidden border border-border">
                {(['BUY', 'SELL'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSide(s)}
                    className={`flex-1 py-1 text-[10px] ${side === s ? (s === 'BUY' ? 'bg-[#00c896] text-black' : 'bg-[#ff4d5e] text-black') : 'text-muted-foreground'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Product</span>
              <select
                value={productType}
                onChange={(e) => setProductType(e.target.value as 'MIS' | 'CNC' | 'NRML')}
                className="h-6 rounded bg-secondary/70 px-1 outline-none"
              >
                <option>MIS</option>
                <option>NRML</option>
                <option>CNC</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Order type</span>
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'MARKET' | 'LIMIT' | 'SL' | 'SL-M')}
                className="h-6 rounded bg-secondary/70 px-1 outline-none"
              >
                <option>MARKET</option>
                <option>LIMIT</option>
                <option>SL</option>
                <option>SL-M</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Qty (lots)</span>
              <input
                type="number"
                min={0}
                value={qty}
                onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))}
                className="h-6 rounded bg-secondary/70 px-1 tabular outline-none focus:ring-1 ring-primary/60"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Qty mode</span>
              <select
                value={qtyMode}
                onChange={(e) => setQtyMode(e.target.value as 'AUTO' | 'MANUAL')}
                className="h-6 rounded bg-secondary/70 px-1 outline-none"
              >
                <option>AUTO</option>
                <option>MANUAL</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase">Limit price</span>
              <input
                type="number"
                min={0}
                value={limitPrice ?? ''}
                onChange={(e) => setLimitPrice(e.target.value ? Number(e.target.value) : null)}
                placeholder="—"
                className="h-6 rounded bg-secondary/70 px-1 tabular outline-none focus:ring-1 ring-primary/60"
              />
            </label>
          </div>
          <div className="pt-1.5 text-[9px] text-muted-foreground">
            Chart price clicks set the limit price; panels fire with these settings.
          </div>
        </div>
      )}
    </div>
  )
}

// ---- deploy by level + schedule --------------------------------

function LevelDeploy({ ws, apiKey }: { ws: WorkspaceCfg; apiKey: string }) {
  void apiKey
  const [open, setOpen] = useState(false)
  const [schedOpen, setSchedOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const underlying = ws.strikes?.underlying ?? ws.symbol
  const lotsPct = ws.lotsPct ?? 10
  const orderType = useTerminal((s) => s.orderType)
  const productType = useTerminal((s) => s.productType)

  // chain (sync + REST fallback, same pattern as the spot overlay)
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    (d) => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === underlying,
    { chains: [{ underlying, expiry: ws.strikes?.expiry ?? null }] }
  )
  const { data: restChain } = useQuery({
    queryKey: ['qd-level-chain', underlying, ws.strikes?.expiry ?? ''],
    queryFn: () => api.optionChain(underlying, ws.strikes?.expiry ?? null, []),
    refetchInterval: 8000,
    retry: false,
  })
  const chain = mergeChain(chainSync, restChain ?? null)
  const meta = chain?.meta ?? null

  useEffect(() => {
    if (!open && !schedOpen) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setSchedOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open, schedOpen])

  const strikeFor = (type: 'CE' | 'PE', level: QdScheduleLevel): number | null => {
    if (!meta) return null
    const dir: -1 | 0 | 1 = level === 'ATM' ? 0 : level.startsWith('ITM') ? -1 : 1
    const n = level === 'ATM' ? 0 : Number(level.slice(3)) || 0
    return sideStrikeFor({ ce: meta.ceAtm, pe: meta.peAtm }, meta.step, dir, n, type)
  }

  const cellFor = (type: 'CE' | 'PE', level: QdScheduleLevel) => {
    const strike = strikeFor(type, level)
    if (strike == null) return null
    const row = chain?.rows.find((r) => r.strike === strike)
    const cell = row ? (type === 'CE' ? row.ce : row.pe) : null
    return cell?.exists ? cell : null
  }

  const deployLevel = async (type: 'CE' | 'PE', level: QdScheduleLevel) => {
    const cell = cellFor(type, level)
    if (!cell) {
      toast.error(`${type} ${level} — no quote (chain not ready)`)
      return
    }
    try {
      const res = await api.placeOrder({
        symbol: cell.symbol,
        exchange: resolveExchange(cell.symbol),
        side: 'BUY',
        qty: 0,
        capitalPct: lotsPct,
        orderType,
        productType,
        source: 'MANUAL',
        tag: `level:${level}`,
      })
      if (res.status === 'FAILED') toast.error(`Deploy ${type} ${level} failed — ${res.message}`)
      else toast.success(`Deployed ${type} ${level} — ${cell.symbol}`)
      window.dispatchEvent(new CustomEvent('oa:blotter-refresh'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Deploy failed')
    }
  }

  return (
    <div ref={boxRef} className="relative flex items-center gap-1 shrink-0">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">level</span>
      </div>
      {(['CE', 'PE'] as const).map((type) => (
        <div key={type} className="relative">
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o)
              setSchedOpen(false)
            }}
            className={`px-1.5 py-1 rounded text-[10px] font-medium ${type === 'CE' ? 'bg-[#00c896]/15 text-[#00c896]' : 'bg-[#ff4d5e]/15 text-[#ff4d5e]'}`}
            title={`Deploy ${type} by level — ${lotsPct}% of capital per strike, ${orderType} ${productType}`}
          >
            {type} ▾
          </button>
          {open && (
            <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-popover shadow-lg p-1">
              {LEVELS.map((lv) => {
                const cell = cellFor(type, lv)
                return (
                  <button
                    key={lv}
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      void deployLevel(type, lv)
                    }}
                    className="w-full flex items-center justify-between px-2 py-1 rounded text-[11px] hover:bg-secondary text-left"
                  >
                    <span className="tabular">{lv}</span>
                    <span className="text-[9px] text-muted-foreground tabular">
                      {cell ? cell.ltp.toFixed(1) : (strikeFor(type, lv) ?? '—')}
                    </span>
                  </button>
                )
              })}
              <div className="h-px bg-border my-0.5" />
              <div className="px-2 py-1 text-[8px] text-muted-foreground">
                {lotsPct}% of capital · {orderType} · {productType}
              </div>
            </div>
          )}
        </div>
      ))}
      {/* schedule */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setSchedOpen((o) => !o)
            setOpen(false)
          }}
          className="flex items-center gap-1 px-1.5 py-1 rounded bg-secondary/70 hover:bg-secondary text-[10px]"
          title="Schedule a level deploy — clock trigger (IST), once or daily"
        >
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden xl:inline">Schedule</span>
        </button>
        {schedOpen && (
          <SchedulePopover
            ws={ws}
            strikeFor={strikeFor}
            cellFor={cellFor}
            onClose={() => setSchedOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

// ---- schedule popover ------------------------------------------

function SchedulePopover({
  ws,
  strikeFor,
  cellFor,
  onClose,
}: {
  ws: WorkspaceCfg
  strikeFor(type: 'CE' | 'PE', level: QdScheduleLevel): number | null
  cellFor(type: 'CE' | 'PE', level: QdScheduleLevel): { symbol: string; ltp: number } | null
  onClose(): void
}) {
  const underlying = ws.strikes?.underlying ?? ws.symbol
  const lotsPct = ws.lotsPct ?? 10
  const orderType = useTerminal((s) => s.orderType)
  const productType = useTerminal((s) => s.productType)
  const add = useQdSchedule((s) => s.add)
  const rows = useQdSchedule((s) => s.rows)
  const cancel = useQdSchedule((s) => s.cancel)
  const remove = useQdSchedule((s) => s.remove)

  const [action, setAction] = useState<QdScheduleAction>('BUY_CE')
  const [level, setLevel] = useState<QdScheduleLevel>('ATM')
  const [time, setTime] = useState('09:20')
  const [daily, setDaily] = useState(false)
  const [sizing, setSizing] = useState<'PCT' | 'LOT'>('PCT')
  const [lots, setLots] = useState(1)
  const pending = useMemo(() => rows.filter((r) => r.status === 'pending'), [rows])

  const type: 'CE' | 'PE' = action.endsWith('CE') ? 'CE' : 'PE'
  const side = action.startsWith('BUY') ? 'BUY' : 'SELL'
  const preview = cellFor(type, level)
  const strike = strikeFor(type, level)

  const arm = () => {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
      toast.error('Time must be HH:MM (IST)')
      return
    }
    add({
      id: `sq${Date.now().toString(36)}`,
      underlying,
      action,
      level,
      time,
      repeatDaily: daily,
      sizing,
      lots,
      allocPct: lotsPct,
      orderType,
      productType,
      status: 'pending',
      createdAt: Date.now(),
    })
    toast.success(
      `Scheduled ${side} ${underlying} ${level} ${type} @ ${time} IST${daily ? ' daily' : ''}`
    )
    onClose()
  }

  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg p-2 text-[11px]">
      <div className="flex items-center gap-1 pb-1.5">
        <Clock className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">Schedule level deploy</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase">Action</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as QdScheduleAction)}
            className="h-6 rounded bg-secondary/70 px-1 outline-none"
          >
            <option value="BUY_CE">BUY CE</option>
            <option value="BUY_PE">BUY PE</option>
            <option value="SELL_CE">SELL CE</option>
            <option value="SELL_PE">SELL PE</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase">Level</span>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as QdScheduleLevel)}
            className="h-6 rounded bg-secondary/70 px-1 outline-none"
          >
            {LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase">Time (IST)</span>
          <input
            value={time}
            onChange={(e) => setTime(e.target.value)}
            placeholder="HH:MM"
            className="h-6 rounded bg-secondary/70 px-1 tabular outline-none focus:ring-1 ring-primary/60"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase">Repeat</span>
          <select
            value={daily ? 'daily' : 'once'}
            onChange={(e) => setDaily(e.target.value === 'daily')}
            className="h-6 rounded bg-secondary/70 px-1 outline-none"
          >
            <option value="once">Once</option>
            <option value="daily">Daily</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] text-muted-foreground uppercase">Sizing</span>
          <select
            value={sizing}
            onChange={(e) => setSizing(e.target.value as 'PCT' | 'LOT')}
            className="h-6 rounded bg-secondary/70 px-1 outline-none"
          >
            <option value="PCT">{lotsPct}% of capital</option>
            <option value="LOT">Fixed lots</option>
          </select>
        </label>
        {sizing === 'LOT' && (
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] text-muted-foreground uppercase">Lots</span>
            <input
              type="number"
              min={1}
              value={lots}
              onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))}
              className="h-6 rounded bg-secondary/70 px-1 tabular outline-none"
            />
          </label>
        )}
      </div>
      <div className="pt-1.5 text-[9px] text-muted-foreground tabular">
        {type} {strike ?? '—'} {preview ? `· ${preview.symbol} · ${preview.ltp.toFixed(1)}` : ''} ·{' '}
        {orderType} · {productType}
      </div>
      <button
        type="button"
        onClick={arm}
        className="mt-1.5 w-full py-1 rounded bg-primary text-primary-foreground text-[11px] font-medium"
      >
        Arm schedule
      </button>
      {pending.length > 0 && (
        <div className="mt-1.5 border-t border-border pt-1">
          <div className="text-[9px] text-muted-foreground pb-0.5">Armed ({pending.length})</div>
          {pending.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center gap-1 py-0.5 text-[10px]">
              <span className="tabular text-muted-foreground">{r.time}</span>
              <span className="flex-1 truncate">
                {r.action.startsWith('BUY') ? 'B' : 'S'} {r.level}{' '}
                {r.action.endsWith('CE') ? 'CE' : 'PE'}
                {r.repeatDaily ? ' ·daily' : ''}
              </span>
              <button
                type="button"
                title="Cancel"
                onClick={() => cancel(r.id)}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <button
                type="button"
                title="Delete"
                onClick={() => remove(r.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
