/**
 * The underlying picker in the Deploy panel's title band: type, wait a
 * beat, pick. It searches the broker's whole instrument table the way the
 * chart's own search box does — the same POST /api/v1/search the terminal
 * runs — so an index, an F&O underlying or a plain equity all resolve from
 * one box. Picking a result charts it, and the panel follows the chart.
 */

import { SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SymbolHit {
  symbol: string
  exchange: string
  name?: string
  lotsize?: number
}

/**
 * The broker-wide instrument search, shared: the combobox above and the
 * panel's stock-add strip both read it. Same POST /api/v1/search the chart
 * terminal runs; dedupes and trims.
 */
export async function searchInstruments(apiKey: string, query: string): Promise<SymbolHit[]> {
  const res = await fetch('/api/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey, query }),
  })
  const j = (await res.json().catch(() => ({}))) as { status?: string; data?: SymbolHit[] }
  const list = (j.data ?? []).filter(
    (hit, index, all) =>
      all.findIndex((h) => h.symbol === hit.symbol && h.exchange === hit.exchange) === index
  )
  return list.slice(0, 24)
}

interface Props {
  apiKey: string
  /** The instrument the panel currently follows, shown on the trigger. */
  current?: { symbol: string; exchange: string } | null
  /** Charts the pick in the focused pane; the panel follows the chart. */
  onPick(hit: SymbolHit): void
  placeholder?: string
}

export function SymbolCombobox({ apiKey, current, onPick, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SymbolHit[]>([])
  const [searching, setSearching] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const requestId = useRef(0)

  // Debounced search with a request-id guard, so a slow response for an
  // earlier keystroke can never overwrite a fresh one.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setHits([])
      setNotFound(false)
      setSearching(false)
      return
    }
    const id = ++requestId.current
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const list = await searchInstruments(apiKey, trimmed)
        if (id !== requestId.current) return
        setHits(list)
        setNotFound(list.length === 0)
      } catch {
        if (id !== requestId.current) return
        setHits([])
        setNotFound(true)
      } finally {
        if (id === requestId.current) setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [apiKey, open, query])

  const pick = (hit: SymbolHit) => {
    setOpen(false)
    setQuery('')
    setHits([])
    onPick(hit)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 max-w-[150px] gap-1 px-1.5 text-[10px] font-mono font-semibold"
          title="Switch the underlying this panel trades"
        >
          <SearchIcon className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{current?.symbol || placeholder || 'Symbol…'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder || 'Search index, F&O or stock…'}
            className="h-8 text-[11px]"
          />
          <CommandList className="max-h-[240px]">
            {notFound && !searching && <CommandEmpty className="text-[11px]">No instrument found.</CommandEmpty>}
            {searching && (
              <p className="px-3 py-2 text-[10px] text-muted-foreground">Searching…</p>
            )}
            {hits.length > 0 && (
              <CommandGroup>
                {hits.map((hit) => (
                  <CommandItem
                    key={`${hit.exchange}:${hit.symbol}`}
                    value={`${hit.exchange}:${hit.symbol}`}
                    onSelect={() => pick(hit)}
                    className="gap-1.5 text-[11px]"
                  >
                    <span className="font-mono font-semibold">{hit.symbol}</span>
                    <span
                      className={cn(
                        'rounded px-1 py-0 text-[9px]',
                        hit.exchange === 'NSE_INDEX' || hit.exchange === 'BSE_INDEX'
                          ? 'bg-amber-500/20 text-amber-600'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {hit.exchange}
                    </span>
                    {hit.name && (
                      <span className="truncate text-[10px] text-muted-foreground">{hit.name}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
