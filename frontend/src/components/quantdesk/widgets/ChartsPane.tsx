import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CanvasChart } from '../chart/canvas-chart'
import { commitChartLevel, useChartCore, useChartMarkers } from '../lib/chartMarkers'
import { api, fmtMoney, registerExchange, resolveExchange } from '../lib/client-api'
import { Panel, PanelGroup, PanelResizeHandle } from '../lib/rsp-compat'
import {
  useTerminal,
  type WorkspaceCfg,
  type WsLayout,
  wsLayout,
  wsSlotSymbols,
} from '../lib/store'
import { mergeChain, type SyncChainResp, type SyncCore, useSyncData } from '../lib/sync'
import { WorkspacePanes } from '../panels/option-panes'

// ============================================================
// Charts pane — the workspace's chart area.
//
// Layouts (toolbar picks, flexible-resize via panel handles):
//   1        single spot chart
//   S+2      spot top · live-ATM CE | PE panes below (F&O default)
//   2×2      spot + CE + PE + scratch pane
//   T+1/T+2  one chart on top + N rows below (slot charts)
//   L+1/L+2  one chart at left + N columns to the right
// Slot panes carry their own symbol (header search) and share the
// workspace timeframe, so the crosshair syncs across every pane.
// ============================================================

const SLOT_COUNT: Partial<Record<WsLayout, number>> = { v2: 1, v3: 2, h2: 1, h3: 2 }

export function ChartsPane({
  ws,
  focusedPaneKey,
  onFocusedPane,
}: {
  ws: WorkspaceCfg
  focusedPaneKey: string | null
  onFocusedPane(key: string): void
}) {
  const core = useChartCore()
  const layout = wsLayout(ws)
  const spotKey = `${ws.id}:spot`
  const slots = SLOT_COUNT[layout] ?? 0

  const spot = (
    <SpotChart
      ws={ws}
      core={core}
      focused={focusedPaneKey === spotKey}
      onFocusedPane={onFocusedPane}
    />
  )

  if (layout === 'single') {
    return <div className="h-full min-h-0">{spot}</div>
  }
  if (layout === 'spot-atm' || layout === 'grid4') {
    return (
      <div className="h-full min-h-0" onMouseDown={() => onFocusedPane(spotKey)}>
        <WorkspacePanes ws={ws} spot={spot} />
      </div>
    )
  }
  // slot layouts — T+1/T+2 (top + rows below), L+1/L+2 (left + columns right)
  const vertical = layout.startsWith('v')
  const slotEls = Array.from({ length: slots }, (_, i) => (
    <SlotPane
      key={`${ws.id}:slot${i}`}
      ws={ws}
      index={i}
      core={core}
      focused={focusedPaneKey === `${ws.id}:slot${i}`}
      onFocusedPane={onFocusedPane}
    />
  ))
  return (
    <PanelGroup direction={vertical ? 'vertical' : 'horizontal'} className="h-full">
      <Panel defaultSize={vertical ? 58 : 55} minSize={20}>
        <div className="h-full min-h-0">{spot}</div>
      </Panel>
      <PanelResizeHandle
        className={
          vertical ? 'h-px bg-border hover:bg-primary/50' : 'w-px bg-border hover:bg-primary/50'
        }
      />
      {slotEls.map((el, i) => (
        <Panel key={i} defaultSize={(vertical ? 42 : 45) / slots} minSize={12}>
          <div className="h-full min-h-0">{el}</div>
        </Panel>
      ))}
    </PanelGroup>
  )
}

// ---- spot chart (full wiring, ported from the upstream terminal view) ----

function SpotChart({
  ws,
  core,
  focused,
  onFocusedPane,
}: {
  ws: WorkspaceCfg
  core: SyncCore | null
  focused: boolean
  onFocusedPane(key: string): void
}) {
  const setLimitPrice = useTerminal((s) => s.setLimitPrice)
  const setOrderType = useTerminal((s) => s.setOrderType)
  const spotKey = `${ws.id}:spot`
  const spotMarkers = useChartMarkers(ws.symbol, core)

  // F&O-ness via the adapter's option underlyings
  const { data: undData } = useQuery({
    queryKey: ['optionUnderlyings'],
    queryFn: () => api.optionUnderlyings(),
    staleTime: 5 * 60_000,
  })
  const isFnOUnderlying = useMemo(
    () => (undData?.underlyings ?? []).some((u) => u.underlying === ws.symbol),
    [ws.symbol, undData]
  )
  const isFno = isFnOUnderlying

  // spot strike overlay data (chain via sync + REST fallback merge)
  const chainSync = useSyncData<SyncChainResp>(
    'sync:chain',
    (d) => !!d && (d as { meta?: { underlying?: string } }).meta?.underlying === ws.symbol,
    isFno ? { chains: [{ underlying: ws.symbol, expiry: ws.strikes?.expiry ?? null }] } : undefined
  )
  const { data: restChain } = useQuery({
    queryKey: ['spotChain', ws.symbol, ws.strikes?.expiry ?? ''],
    queryFn: () => api.optionChain(ws.symbol, ws.strikes?.expiry ?? null, []),
    enabled: isFno,
    refetchInterval: 8000,
    retry: false,
  })
  const spotChain = mergeChain(chainSync, restChain ?? null)
  const spotStrikeRows = useMemo(
    () =>
      (spotChain?.rows ?? [])
        .filter((r) => Math.abs(r.offset) <= 7)
        .map((r) => ({
          strike: r.strike,
          ce: r.ce?.ltp ?? 0,
          pe: r.pe?.ltp ?? 0,
          ceSym: r.ce?.symbol ?? '',
          peSym: r.pe?.symbol ?? '',
        })),
    [spotChain]
  )
  const { data: fundsData } = useQuery({
    queryKey: ['spot-capital'],
    queryFn: () => api.funds(),
    refetchInterval: 30_000,
  })
  const spotCapital = useMemo(
    () => (fundsData?.funds ?? []).reduce((s, f) => s + (f.cash || 0), 0),
    [fundsData]
  )

  const onStrikeOrder = (
    sym: string,
    side: 'BUY' | 'SELL',
    lots: number,
    strike: number,
    kind: 'CE' | 'PE'
  ) => {
    void (async () => {
      try {
        registerExchange(sym, resolveExchange(sym))
        const res = await api.placeOrder({
          symbol: sym,
          exchange: resolveExchange(sym),
          side,
          qty: lots,
          orderType: 'MARKET',
          productType: 'MIS',
          source: 'MANUAL',
        })
        const f = res.legs.filter((l) => l.status === 'FILLED').length
        res.status === 'FAILED'
          ? toast.error(`${side} ${strike} ${kind} failed — ${res.message}`)
          : toast.success(
              `${side} ${strike} ${kind} × ${lots} lot(s) — ${f}/${res.legs.length} filled`
            )
        window.dispatchEvent(new CustomEvent('oa:blotter-refresh'))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Order failed')
      }
    })()
  }

  const onMarkerDrop = (kind: 'sl' | 'target', price: number) => {
    void commitChartLevel(ws.symbol, kind, price, core)
  }
  const onMarkerRemove = (kind: 'sl' | 'target') => {
    useTerminal.getState().setChartLevel(ws.symbol, kind, null)
    toast.info(`${kind === 'sl' ? 'SL' : 'Target'} level removed`)
  }

  return (
    <div
      className={`h-full min-h-0 ${focused ? 'ring-1 ring-inset ring-primary/40' : ''}`}
      onMouseDown={() => onFocusedPane(spotKey)}
    >
      <CanvasChart
        symbol={ws.symbol}
        tf={ws.tf}
        chartType={ws.chartType}
        showVolume={ws.showVolume}
        showSMA20={ws.showSMA20}
        showSMA50={ws.showSMA50}
        showEMA={ws.showEMA}
        showVWAP={ws.showVWAP}
        showBOLL={ws.showBOLL}
        showRSI={ws.showRSI}
        showMACD={ws.showMACD}
        showADX={ws.showADX}
        showGhost={ws.showGhost}
        ghostStyle={ws.ghostStyle}
        ghostTf={ws.ghostTf}
        scales={ws.scales}
        markers={spotMarkers}
        onMarkerDrop={onMarkerDrop}
        onMarkerRemove={onMarkerRemove}
        onPriceClick={(p) => {
          setLimitPrice(p)
          setOrderType('LIMIT')
        }}
        strikeOverlay={
          isFno && spotChain?.meta
            ? {
                enabled: ws.strikeOverlay ?? true,
                lotSize: spotChain.meta.lotSize ?? 75,
                step: spotChain.meta.step ?? 50,
                atm: spotChain.meta.atm ?? 0,
                rows: spotStrikeRows,
              }
            : undefined
        }
        capital={spotCapital}
        lotsPct={ws.lotsPct ?? 10}
        onStrikeOrder={onStrikeOrder}
        settingsKey={spotKey}
        height="h-full"
      />
    </div>
  )
}

// ---- slot panes (T+n / L+n layouts) -----------------------------

function SlotPane({
  ws,
  index,
  core,
  focused,
  onFocusedPane,
}: {
  ws: WorkspaceCfg
  index: number
  core: SyncCore | null
  focused: boolean
  onFocusedPane(key: string): void
}) {
  const setLimitPrice = useTerminal((s) => s.setLimitPrice)
  const setOrderType = useTerminal((s) => s.setOrderType)
  const key = `${ws.id}:slot${index}`
  const slots = wsSlotSymbols(ws, Math.max(index + 1, SLOT_COUNT[wsLayout(ws)] ?? 0))
  const symbol = slots[index] ?? ws.symbol
  const markers = useChartMarkers(symbol, core)

  return (
    <div
      className={`h-full flex flex-col min-h-0 ${focused ? 'ring-1 ring-inset ring-primary/40' : ''}`}
    >
      <SlotHeader ws={ws} index={index} symbol={symbol} onFocused={() => onFocusedPane(key)} />
      <div className="flex-1 min-h-0" onMouseDown={() => onFocusedPane(key)}>
        <CanvasChart
          symbol={symbol}
          tf={ws.tf}
          chartType={ws.chartType}
          showVolume={ws.showVolume}
          showSMA20={ws.showSMA20}
          showSMA50={ws.showSMA50}
          showEMA={ws.showEMA}
          showVWAP={ws.showVWAP}
          showBOLL={ws.showBOLL}
          showRSI={ws.showRSI}
          showMACD={ws.showMACD}
          showADX={ws.showADX}
          showGhost={ws.showGhost}
          ghostStyle={ws.ghostStyle}
          ghostTf={ws.ghostTf}
          scales={ws.scales}
          markers={markers}
          onMarkerDrop={(kind, price) => {
            void commitChartLevel(symbol, kind, price, core)
          }}
          onMarkerRemove={(kind) => {
            useTerminal.getState().setChartLevel(symbol, kind, null)
            toast.info(`${kind === 'sl' ? 'SL' : 'Target'} level removed`)
          }}
          onPriceClick={(p) => {
            setLimitPrice(p)
            setOrderType('LIMIT')
          }}
          settingsKey={key}
          height="h-full"
        />
      </div>
    </div>
  )
}

function SlotHeader({
  ws,
  index,
  symbol,
  onFocused,
}: {
  ws: WorkspaceCfg
  index: number
  symbol: string
  onFocused(): void
}) {
  const patchWs = useTerminal((s) => s.patchWs)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ symbol: string; name: string; exchange: string }[]>([])
  const boxRef = useRef<HTMLDivElement>(null)
  const ltp = useSlotLtp(symbol)

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      void api
        .symbols(q)
        .then((r) => {
          setHits(
            r.symbols
              .filter((s) => !/(CE|PE)$/.test(s.symbol))
              .slice(0, 8)
              .map((s) => ({ symbol: s.symbol, name: s.name, exchange: s.exchange }))
          )
        })
        .catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [query, open])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const pick = (sym: string, exchange?: string) => {
    if (exchange) registerExchange(sym, exchange)
    const cur = [...(ws.slotSymbols ?? [])]
    while (cur.length <= index) cur.push(null)
    cur[index] = sym
    patchWs(ws.id, { slotSymbols: cur })
    setOpen(false)
    setQuery('')
  }

  return (
    <div
      ref={boxRef}
      className="relative flex items-center gap-1 px-1.5 h-6 border-b border-border bg-card/40 shrink-0"
      onMouseDown={onFocused}
    >
      <button
        type="button"
        className="flex items-center gap-1 text-[10px] font-medium hover:text-foreground text-foreground/90"
        onClick={() => setOpen((o) => !o)}
        title="Change this pane's symbol"
      >
        <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
        {symbol}
        <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
      </button>
      {ltp != null && (
        <span className="text-[9px] tabular text-muted-foreground">{fmtMoney(ltp)}</span>
      )}
      {open && (
        <div className="absolute z-50 mt-1 w-60 rounded-md border border-border bg-popover shadow-lg p-1.5">
          <input
            // biome-ignore lint/a11y/noAutofocus: an opened search popover takes focus so the user can type at once.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbol…"
            className="w-full h-6 rounded bg-secondary/70 px-1.5 text-[11px] outline-none focus:ring-1 ring-primary/60"
          />
          <div className="max-h-40 overflow-y-auto">
            {hits.map((h) => (
              <button
                key={`${h.exchange}:${h.symbol}`}
                type="button"
                onClick={() => pick(h.symbol, h.exchange)}
                className="w-full flex items-center justify-between px-1.5 py-0.5 rounded text-[11px] hover:bg-secondary text-left"
              >
                <span>{h.symbol}</span>
                <span className="text-[8px] text-muted-foreground truncate max-w-32">
                  {h.name || h.exchange}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function useSlotLtp(symbol: string): number | null {
  const [ltp, setLtp] = useState<number | null>(null)
  useEffect(() => {
    setLtp(null)
    let live = true
    const iv = setInterval(() => {
      void api
        .quote(symbol)
        .then((q) => {
          if (live) setLtp(q.ltp || null)
        })
        .catch(() => undefined)
    }, 5000)
    void api
      .quote(symbol)
      .then((q) => {
        if (live) setLtp(q.ltp || null)
      })
      .catch(() => undefined)
    return () => {
      live = false
      clearInterval(iv)
    }
  }, [symbol])
  return ltp
}
