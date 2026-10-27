/**
 * The Depth tab: the instruments whose order books the trader is watching,
 * one card each with the five-level ladder from the broker's depth feed.
 *
 * The list is the trader's — add any instrument through the search, remove
 * it with the card's ×, and a deploy row's Depth button appends its
 * instrument and opens this tab (the panel and the dock share nothing, so
 * the request rides the depth bus). The list and the open order survive a
 * reload; the depth itself is a live poll, like every book in the dock.
 */

import { X, SearchIcon, LineChart } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DepthData } from '@/api/trading'
import { tradingApi } from '@/api/trading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { searchInstruments } from '@/components/trading/SymbolCombobox'
import { onDepthRequest } from '@/lib/trading/depthBus'
import { cn } from '@/lib/utils'

const DEPTH_ITEMS_KEY = 'oa-trading-depth-items'
const DEPTH_OPEN_KEY = 'oa-trading-depth-open'
const DEPTH_POLL_MS = 3000
const MAX_ITEMS = 8

interface DepthItem {
  symbol: string
  exchange: string
}

function readItems(): DepthItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEPTH_ITEMS_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (item): item is DepthItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as DepthItem).symbol === 'string' &&
          (item as DepthItem).symbol.length > 0
      )
      .map((item) => ({
        symbol: item.symbol,
        exchange: typeof item.exchange === 'string' && item.exchange ? item.exchange : 'NSE',
      }))
      .slice(0, MAX_ITEMS)
  } catch {
    return []
  }
}

function writeItems(items: DepthItem[]): void {
  try {
    localStorage.setItem(DEPTH_ITEMS_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
  } catch {
    // Storage refused: the list holds for this visit only.
  }
}

function readOpenKey(): string | null {
  try {
    return localStorage.getItem(DEPTH_OPEN_KEY)
  } catch {
    return null
  }
}

function writeOpenKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(DEPTH_OPEN_KEY, key)
    else localStorage.removeItem(DEPTH_OPEN_KEY)
  } catch {
    // As above.
  }
}

export function DepthTab(props: {
  apiKey: string
  /** Charts a row in the focused pane, the way the other tabs' picks do. */
  onPick(row: { symbol: string; exchange: string; name?: string }): void
}) {
  const [items, setItems] = useState<DepthItem[]>(readItems)
  const [openKey, setOpenKey] = useState<string | null>(readOpenKey)
  const [addOpen, setAddOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ symbol: string; exchange: string; name?: string }>>([])
  const [searching, setSearching] = useState(false)

  // A deploy row's Depth button lands here: append (or surface) the
  // instrument and open its card.
  useEffect(
    () =>
      onDepthRequest((request) => {
        const key = `${request.exchange}:${request.symbol}`
        setItems((previous) => {
          const next = previous.some((item) => `${item.exchange}:${item.symbol}` === key)
            ? previous
            : [...previous, { symbol: request.symbol, exchange: request.exchange }].slice(
                -MAX_ITEMS
              )
          writeItems(next)
          return next
        })
        setOpenKey(key)
        writeOpenKey(key)
      }),
    []
  )

  const add = (hit: { symbol: string; exchange: string }) => {
    const key = `${hit.exchange}:${hit.symbol}`
    setItems((previous) => {
      if (previous.some((item) => `${item.exchange}:${item.symbol}` === key)) {
        setOpenKey(key)
        return previous
      }
      const next = [...previous, { symbol: hit.symbol, exchange: hit.exchange }].slice(-MAX_ITEMS)
      writeItems(next)
      return next
    })
    setOpenKey(key)
    writeOpenKey(key)
    setAddOpen(false)
    setQuery('')
    setHits([])
  }

  const remove = (item: DepthItem) => {
    setItems((previous) => {
      const next = previous.filter(
        (row) => !(row.symbol === item.symbol && row.exchange === item.exchange)
      )
      writeItems(next)
      return next
    })
    const key = `${item.exchange}:${item.symbol}`
    if (openKey === key) {
      setOpenKey(null)
      writeOpenKey(null)
    }
  }

  // The stock strip searches while it is open — the same broker-wide search
  // the deploy panel's stock list runs.
  useEffect(() => {
    if (!addOpen) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const list = await searchInstruments(props.apiKey, trimmed)
        if (alive) setHits(list)
      } catch {
        if (alive) setHits([])
      } finally {
        if (alive) setSearching(false)
      }
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [addOpen, query, props.apiKey])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <span className="text-[10px] text-muted-foreground">
          {items.length === 0
            ? 'Add an instrument to watch its five-level order book.'
            : `${items.length} of ${MAX_ITEMS} watched — a deploy row's depth button adds here.`}
        </span>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="ml-auto h-5 gap-1 px-1.5 text-[10px]">
              <SearchIcon className="h-2.5 w-2.5" />
              Add
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[240px] p-2" align="end">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search any instrument…"
              className="h-7 text-xs"
            />
            <div className="mt-1 max-h-[200px] overflow-y-auto">
              {searching && <p className="px-1 py-1 text-[10px] text-muted-foreground">Searching…</p>}
              {!searching && hits.length === 0 && query.trim().length >= 2 && (
                <p className="px-1 py-1 text-[10px] text-muted-foreground">No instrument found.</p>
              )}
              {hits.map((hit) => (
                <button
                  key={`${hit.exchange}:${hit.symbol}`}
                  type="button"
                  onClick={() => add(hit)}
                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] hover:bg-accent"
                >
                  <span className="font-mono font-semibold">{hit.symbol}</span>
                  <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                    {hit.exchange}
                  </span>
                  {hit.name && (
                    <span className="truncate text-[10px] text-muted-foreground">{hit.name}</span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="p-4 text-center text-[12px] text-muted-foreground">
            Nothing watched yet — search above, or press the depth button on a deploy row.
          </p>
        )}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <DepthCard
              key={`${item.exchange}:${item.symbol}`}
              apiKey={props.apiKey}
              item={item}
              open={openKey === `${item.exchange}:${item.symbol}`}
              onToggle={() => {
                const key = `${item.exchange}:${item.symbol}`
                const next = openKey === key ? null : key
                setOpenKey(next)
                writeOpenKey(next)
              }}
              onRemove={() => remove(item)}
              onPick={props.onPick}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** One watched instrument: header row, then the five-level ladder when open. */
function DepthCard(props: {
  apiKey: string
  item: DepthItem
  open: boolean
  onToggle(): void
  onRemove(): void
  onPick(row: { symbol: string; exchange: string; name?: string }): void
}) {
  const [depth, setDepth] = useState<DepthData | null>(null)
  const [failed, setFailed] = useState(false)
  const key = `${props.item.exchange}:${props.item.symbol}`

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await tradingApi.getDepth(props.apiKey, props.item.symbol, props.item.exchange)
        if (!alive) return
        if (res.status === 'success' && res.data) {
          setDepth(res.data)
          setFailed(false)
        } else {
          setFailed(true)
        }
      } catch {
        if (alive) setFailed(true)
      }
    }
    // A closed card still keeps its header honest (ltp, OI) at a slower
    // stride; only the open card polls full tilt.
    void poll()
    const timer = window.setInterval(poll, props.open ? DEPTH_POLL_MS : DEPTH_POLL_MS * 3)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [props.apiKey, props.item.symbol, props.item.exchange, props.open])

  const bids = useMemo(() => (depth?.bids ?? []).slice(0, 5), [depth])
  const asks = useMemo(() => (depth?.asks ?? []).slice(0, 5), [depth])

  return (
    <div className="rounded border bg-background" data-depth-key={key}>
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span className="font-mono text-[11px] font-semibold">{props.item.symbol}</span>
          <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
            {props.item.exchange}
          </span>
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              depth?.ltp == null && 'text-muted-foreground'
            )}
          >
            {depth?.ltp != null ? depth.ltp.toFixed(2) : failed ? '—' : '…'}
          </span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 px-0"
          title="Load this instrument in the chart"
          onClick={() => props.onPick({ ...props.item })}
        >
          <LineChart className="h-3 w-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-4 shrink-0 px-0 text-muted-foreground"
          onClick={props.onRemove}
          title="Stop watching"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {props.open &&
        (failed && !depth ? (
          <p className="px-2 pb-2 text-[10px] text-muted-foreground">
            Depth is unavailable for {props.item.symbol} — some instruments carry no order book.
          </p>
        ) : (
          <DepthLadder bids={bids} asks={asks} />
        ))}
    </div>
  )
}

function DepthLadder(props: { bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }> }) {
  const maxQty = Math.max(1, ...props.bids.map((l) => l.quantity), ...props.asks.map((l) => l.quantity))
  return (
    <div className="border-t">
      <div className="grid grid-cols-2 divide-x border-b bg-muted/30 text-[9px] font-semibold uppercase text-muted-foreground">
        <div className="px-2 py-0.5 text-emerald-600">Bids</div>
        <div className="px-2 py-0.5 text-right text-red-600">Asks</div>
      </div>
      <div className="grid grid-cols-2 divide-x">
        <div>
          {props.bids.length === 0 && <p className="px-2 py-1 text-[10px] text-muted-foreground">—</p>}
          {props.bids.map((level, index) => (
            <DepthRow key={`bid-${index}`} price={level.price} quantity={level.quantity} maxQty={maxQty} side="buy" />
          ))}
        </div>
        <div>
          {props.asks.length === 0 && <p className="px-2 py-1 text-right text-[10px] text-muted-foreground">—</p>}
          {props.asks.map((level, index) => (
            <DepthRow key={`ask-${index}`} price={level.price} quantity={level.quantity} maxQty={maxQty} side="sell" />
          ))}
        </div>
      </div>
    </div>
  )
}

function DepthRow(props: { price: number; quantity: number; maxQty: number; side: 'buy' | 'sell' }) {
  const pct = Math.min((props.quantity / props.maxQty) * 100, 100)
  return (
    <div className="relative flex items-center gap-2 px-2 py-0.5">
      <div className="absolute inset-0 overflow-hidden">
        <div
          className={cn(
            'absolute top-0 bottom-0 transition-all duration-300',
            props.side === 'buy'
              ? 'left-0 bg-gradient-to-r from-emerald-500/20 to-transparent'
              : 'right-0 bg-gradient-to-l from-rose-500/20 to-transparent'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          'relative z-10 font-mono text-[10px] tabular-nums',
          props.side === 'buy' ? 'text-emerald-600' : 'text-red-600'
        )}
      >
        {props.price.toFixed(2)}
      </span>
      <span className="relative z-10 ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
        {props.quantity.toLocaleString('en-IN')}
      </span>
    </div>
  )
}
