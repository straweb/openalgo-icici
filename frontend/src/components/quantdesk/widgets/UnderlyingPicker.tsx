import { ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, registerExchange, registerLotSize, resolveExchange } from '../lib/client-api'
import { useTerminal } from '../lib/store'

// ============================================================
// Underlying selection (top bar, right side).
//
//  · search any underlying (OpenAlgo /search) or pick from the
//    pinned F&O majors
//  · when the underlying carries derivatives, a series dropdown
//    offers SPOT (default), every FUTURES expiry (spot followed by
//    dates) and every OPTIONS expiry (drives the chain/strikes)
//  · defaults to the spot index with the latest expiry
// ============================================================

interface SeriesOpt {
  kind: 'spot' | 'fut' | 'opt'
  label: string
  expiry?: string | null
  /** resolved contract symbol for futures */
  symbol?: string | null
}

export function UnderlyingPicker() {
  const workspaces = useTerminal((s) => s.workspaces)
  const activeWs = useTerminal((s) => s.activeWs)
  const ws = workspaces.find((w) => w.id === activeWs) ?? workspaces[0]
  const patchWs = useTerminal((s) => s.patchWs)
  const setSymbol = useTerminal((s) => s.setSymbol)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ symbol: string; name: string; exchange: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [series, setSeries] = useState<SeriesOpt[]>([])
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [seriesSel, setSeriesSel] = useState<string>('spot')
  const boxRef = useRef<HTMLDivElement>(null)

  // current underlying of the workspace
  const underlying = ws?.symbol ?? 'NIFTY'

  // series (futures + options expiries) for the underlying
  useEffect(() => {
    let live = true
    const opts: SeriesOpt[] = [{ kind: 'spot', label: `Spot · ${underlying}` }]
    const exchange = resolveExchange(underlying)
    const derivExchange = exchange === 'BSE' ? 'BFO' : exchange === 'MCX' ? 'MCX' : 'NFO'
    void (async () => {
      try {
        const [futs, optsExp] = await Promise.all([
          api.expiries(underlying, 'futures').catch(() => [] as string[]),
          api.expiries(underlying, 'options').catch(() => [] as string[]),
        ])
        if (!live) return
        const futRows = futs.map((e) => ({ kind: 'fut' as const, label: `FUT ${e}`, expiry: e }))
        const optRows = optsExp.map((e) => ({ kind: 'opt' as const, label: `OPT ${e}`, expiry: e }))
        setSeries([...opts, ...futRows, ...optRows])
        // remember the derivative exchange for contract search
        registerExchange(`${underlying}|deriv`, derivExchange)
      } catch {
        if (live) setSeries(opts)
      }
    })()
    return () => {
      live = false
    }
  }, [underlying])

  // debounced underlying search
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 1) {
      setHits([])
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      void api
        .symbols(q)
        .then((r) => {
          // prefer the cash/underlying rows, drop option contracts
          const rows = r.symbols.filter((s) => !/(CE|PE)$/.test(s.symbol)).slice(0, 10)
          setHits(rows.map((s) => ({ symbol: s.symbol, name: s.name, exchange: s.exchange })))
          setSearching(false)
        })
        .catch(() => setSearching(false))
    }, 250)
    return () => clearTimeout(t)
  }, [query, open])

  // close on outside click
  useEffect(() => {
    if (!open && !seriesOpen) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setSeriesOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open, seriesOpen])

  const pickUnderlying = (sym: string, exchange?: string) => {
    if (exchange) registerExchange(sym, exchange)
    else
      void api.symbols(sym).then((r) => {
        const exact = r.symbols.find((s) => s.symbol.toUpperCase() === sym.toUpperCase())
        if (exact) registerExchange(sym, exact.exchange)
      })
    setQuery('')
    setOpen(false)
    setSeriesSel('spot')
    // default: the spot index; chain expiry rides "latest" (null)
    setSymbol(sym)
    patchWs(ws.id, { strikes: { underlying: sym, expiry: null, rows: ws.strikes?.rows ?? [] } })
  }

  const pickSeries = async (opt: SeriesOpt) => {
    setSeriesSel(opt.label)
    setSeriesOpen(false)
    if (opt.kind === 'spot') {
      setSymbol(underlying)
      patchWs(ws.id, { strikes: { underlying, expiry: null, rows: ws.strikes?.rows ?? [] } })
      return
    }
    if (opt.kind === 'fut') {
      // resolve the futures contract symbol for this expiry
      try {
        const fut = await api.futuresFor(underlying, opt.expiry ?? null)
        if (fut) {
          registerExchange(
            fut.symbol,
            resolveExchange(underlying) === 'BSE'
              ? 'BFO'
              : resolveExchange(underlying) === 'MCX'
                ? 'MCX'
                : 'NFO'
          )
          if (fut.lotSize) registerLotSize(fut.symbol, fut.lotSize)
          setSymbol(fut.symbol)
          toast.success(`Futures loaded — ${fut.symbol}`)
        } else toast.error(`No futures contract found for ${underlying} ${opt.expiry}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Futures lookup failed')
      }
      return
    }
    // options expiry: chart stays on spot, chain/strikes follow the expiry
    patchWs(ws.id, {
      strikes: { underlying, expiry: opt.expiry ?? null, rows: ws.strikes?.rows ?? [] },
    })
    toast.success(`Options expiry set — ${opt.expiry}`)
  }

  const currentSeries = useMemo(() => {
    if (seriesSel === 'spot') return series[0]?.label ?? `Spot · ${underlying}`
    return seriesSel
  }, [seriesSel, series, underlying])

  if (!ws) return null

  return (
    <div ref={boxRef} className="flex items-center gap-1 relative">
      {/* underlying selector */}
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setSeriesOpen(false)
        }}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary/70 hover:bg-secondary text-[11px] font-medium text-foreground"
        title="Underlying — search any symbol or pick from the F&O list"
      >
        <Search className="h-3 w-3 text-muted-foreground" />
        <span className="max-w-40 truncate">{underlying}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {/* series selector (spot / futures / options expiry) */}
      <button
        type="button"
        onClick={() => {
          setSeriesOpen((o) => !o)
          setOpen(false)
        }}
        className="flex items-center gap-1 px-1.5 py-1 rounded bg-secondary/50 hover:bg-secondary text-[10px] text-muted-foreground hover:text-foreground"
        title="Series — spot (default), futures by expiry, or an options expiry for the chain"
      >
        <span className="max-w-36 truncate tabular">{currentSeries}</span>
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover shadow-lg p-1.5">
          <input
            // biome-ignore lint/a11y/noAutofocus: an opened search popover takes focus so the user can type at once.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search underlying (e.g. NIFTY, RELIANCE, CRUDEOIL)"
            className="w-full h-7 rounded bg-secondary/70 px-2 text-[11px] outline-none focus:ring-1 ring-primary/60"
          />
          <div className="max-h-64 overflow-y-auto mt-1">
            {hits.map((h) => (
              <button
                key={`${h.exchange}:${h.symbol}`}
                type="button"
                onClick={() => pickUnderlying(h.symbol, h.exchange)}
                className="w-full flex items-center justify-between px-2 py-1 rounded text-[11px] hover:bg-secondary text-left"
              >
                <span className="font-medium">{h.symbol}</span>
                <span className="text-[9px] text-muted-foreground truncate max-w-36">
                  {h.name || h.exchange}
                </span>
              </button>
            ))}
            {!query && (
              <div className="px-2 py-1 text-[9px] text-muted-foreground">
                Type to search — or pick a major:
              </div>
            )}
            {!query &&
              [
                'NIFTY',
                'BANKNIFTY',
                'FINNIFTY',
                'MIDCPNIFTY',
                'SENSEX',
                'CRUDEOIL',
                'GOLD',
                'RELIANCE',
                'HDFCBANK',
              ].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickUnderlying(s)}
                  className="w-full px-2 py-1 rounded text-[11px] hover:bg-secondary text-left"
                >
                  {s}
                </button>
              ))}
            {query && !hits.length && !searching && (
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground">No matches</div>
            )}
          </div>
        </div>
      )}

      {seriesOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg p-1 max-h-72 overflow-y-auto">
          {series.length === 0 && (
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground">Loading expiries…</div>
          )}
          {series.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => void pickSeries(o)}
              className={`w-full px-2 py-1 rounded text-[11px] text-left hover:bg-secondary flex items-center justify-between ${seriesSel === o.label ? 'text-primary' : ''}`}
            >
              <span>{o.label}</span>
              {o.kind === 'spot' && (
                <span className="text-[8px] text-muted-foreground">DEFAULT</span>
              )}
              {o.kind === 'fut' && <span className="text-[8px] text-muted-foreground">FUT</span>}
              {o.kind === 'opt' && <span className="text-[8px] text-muted-foreground">OPT</span>}
            </button>
          ))}
          {series.length > 0 && series.every((s) => s.kind === 'spot') && (
            <div className="px-2 py-1.5 text-[9px] text-muted-foreground">
              No F&O expiries for this symbol
            </div>
          )}
        </div>
      )}
    </div>
  )
}
