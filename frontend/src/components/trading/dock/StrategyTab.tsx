/**
 * The strategy dock tab: condition-driven entry and exit, armed onto a list
 * of strikes and run against live ticks.
 *
 * The trader writes two lists — entry and exit — over the index's last
 * price, a leg's premium, and the IST clock to the second, joined AND/OR
 * row by row. Start watches the entry list; when it crosses true the legs'
 * orders go as one multileg batch, the same endpoint the hedging terminal
 * uses, and the bot turns to watching the exit list, the target and the
 * stop on the entry reference. Exit fires the opposite batch and the bot is
 * done. Stop halts a watching bot where it stands; an open bot stops
 * watching but leaves its position — the positions tab squares off what the
 * trader chooses not to hand to the exit list.
 *
 * Every running bot's instruments ride the page's tick hub, so the ladder
 * of live prices under a bot is the same wire the deploy panel reads — no
 * second socket, no polling loop of its own beyond the clock beat the time
 * conditions need.
 */

import { Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hedgingApi } from '@/api/hedging'
import { type SymbolHit, searchInstruments } from '@/components/trading/SymbolCombobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  describeConditions,
  evalConditions,
  exitReason,
  istSecondsNow,
  loadBots,
  newCondition,
  newId,
  parseClockToSec,
  type StrategyBot,
  type StrategyCompare,
  type StrategyCondition,
  type StrategyField,
  type StrategyLeg,
  type StrategyTickContext,
  saveBots,
  secToClock,
} from '@/lib/trading/strategyBot'
import { tickHub } from '@/lib/trading/tickHub'
import { cn } from '@/lib/utils'
import { showToast } from '@/utils/toast'

const ENGINE_BEAT_MS = 250

const COMPARES: readonly StrategyCompare[] = ['<', '<=', '>', '>=', 'between']

const EXCHANGES = ['NSE_INDEX', 'NFO', 'BFO', 'NSE', 'BSE', 'MCX', 'CDS'] as const

const STATUS_TONE: Record<StrategyBot['status'], string> = {
  idle: 'bg-muted text-muted-foreground',
  watching: 'bg-amber-500 text-white',
  open: 'bg-emerald-600 text-white',
  completed: 'bg-sky-600 text-white',
  cancelled: 'bg-muted text-muted-foreground',
  failed: 'bg-red-600 text-white',
}

interface Props {
  apiKey: string
  wsUrl: string
  /** The focused pane's symbol — a new bot's default underlying. */
  activeSymbol: string | null
  /** Replay lock: a bot must not fire into a simulation. */
  refuse(): boolean
  /** The dock's book refresh, so a fire shows up in positions at once. */
  refresh(): void
}

/** Split `EXCHANGE:SYMBOL` for the active-symbol seed; null when it does not read. */
function splitActive(activeSymbol: string | null): { symbol: string; exchange: string } | null {
  if (!activeSymbol) return null
  const at = activeSymbol.indexOf(':')
  if (at <= 0) return null
  return { exchange: activeSymbol.slice(0, at), symbol: activeSymbol.slice(at + 1) }
}

/**
 * The underlying, picked the deploy panel's way: type ahead, the broker-wide
 * search answers, a hit sets symbol and exchange in one press. The plain
 * input it replaces made the trader know the exact symbol AND the exchange
 * it trades on — two guesses where one search should be.
 */
function UnderlyingPick({
  apiKey,
  current,
  onPick,
}: {
  apiKey: string
  current: { symbol: string; exchange: string }
  onPick(hit: SymbolHit): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SymbolHit[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
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
        const list = await searchInstruments(apiKey, trimmed)
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
  }, [apiKey, open, query])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-[12px] font-mono"
          aria-label="Pick the underlying — search the broker's instruments"
        >
          <Search className="h-3 w-3 opacity-60" />
          <span className="max-w-[150px] truncate">{current.symbol || 'pick underlying…'}</span>
          <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
            {current.exchange}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-2" align="start">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="NIFTY, SENSEX, RELIANCE…"
          className="h-7 text-xs"
          aria-label="Search the underlying"
        />
        <div className="mt-1 max-h-[200px] overflow-y-auto">
          {searching && <p className="px-1 py-1 text-[10px] text-muted-foreground">Searching…</p>}
          {!searching && hits.length === 0 && query.trim().length >= 2 && (
            <p className="px-1 py-1 text-[10px] text-muted-foreground">No instrument found.</p>
          )}
          {!searching && query.trim().length < 2 && (
            <p className="px-1 py-1 text-[10px] text-muted-foreground">
              Type two letters — indexes, stocks, anything the broker lists.
            </p>
          )}
          {hits.map((hit) => (
            <button
              key={`${hit.exchange}:${hit.symbol}`}
              type="button"
              onClick={() => {
                onPick(hit)
                setOpen(false)
                setQuery('')
              }}
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
  )
}

/** One condition row's editors, shared by the entry and exit lists. */
function ConditionRow({
  cond,
  legs,
  onChange,
  onRemove,
  first,
}: {
  cond: StrategyCondition
  legs: readonly StrategyLeg[]
  onChange(next: StrategyCondition): void
  onRemove(): void
  first: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded border bg-background/50 px-1 py-1">
      <select
        value={cond.join}
        disabled={first}
        onChange={(e) => onChange({ ...cond, join: e.target.value as 'and' | 'or' })}
        aria-label="Join with the previous condition"
        className="h-6 rounded bg-muted px-1 text-[11px] font-semibold disabled:opacity-40"
      >
        <option value="and">AND</option>
        <option value="or">OR</option>
      </select>
      <select
        value={cond.field}
        onChange={(e) => onChange({ ...cond, field: e.target.value as StrategyField })}
        aria-label="What the condition reads"
        className="h-6 rounded bg-muted px-1 text-[11px]"
      >
        <option value="index">Index</option>
        <option value="strike">Strike</option>
        <option value="time">Time</option>
      </select>
      {cond.field === 'strike' && (
        <select
          value={cond.legId ?? ''}
          onChange={(e) => onChange({ ...cond, legId: e.target.value || undefined })}
          aria-label="Which strike"
          className="h-6 max-w-[140px] rounded bg-muted px-1 text-[11px]"
        >
          <option value="">pick leg…</option>
          {legs.map((leg) => (
            <option key={leg.id} value={leg.id}>
              {leg.symbol}
            </option>
          ))}
        </select>
      )}
      <select
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as StrategyCompare })}
        aria-label="Comparison"
        className="h-6 rounded bg-muted px-1 text-[11px]"
      >
        {COMPARES.map((op) => (
          <option key={op} value={op}>
            {op === 'between' ? 'within' : op}
          </option>
        ))}
      </select>
      {cond.field === 'time' ? (
        <Input
          defaultValue={cond.value ? secToClock(cond.value) : ''}
          placeholder="11:00:00"
          onBlur={(e) => {
            const sec = parseClockToSec(e.target.value)
            onChange({ ...cond, value: sec ?? cond.value })
            if (sec != null) e.target.value = secToClock(sec)
          }}
          aria-label="Time of day (IST)"
          className="h-6 w-[86px] px-1 text-[11px] tabular-nums"
        />
      ) : (
        <Input
          type="number"
          defaultValue={cond.value || ''}
          placeholder="value"
          onBlur={(e) => onChange({ ...cond, value: Number(e.target.value) || 0 })}
          aria-label="Value"
          className="h-6 w-[84px] px-1 text-[11px] tabular-nums"
        />
      )}
      {cond.op === 'between' && (
        <Input
          type="number"
          defaultValue={cond.value2 || ''}
          placeholder="and"
          onBlur={(e) => onChange({ ...cond, value2: Number(e.target.value) || 0 })}
          aria-label="Upper bound"
          className="h-6 w-[84px] px-1 text-[11px] tabular-nums"
        />
      )}
      <span className="ml-auto flex items-center">
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this condition"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
    </div>
  )
}

export function StrategyTab({ apiKey, wsUrl, activeSymbol, refuse, refresh }: Props) {
  const [bots, setBots] = useState<StrategyBot[]>(() => loadBots())
  const [draft, setDraft] = useState<StrategyBot | null>(null)
  /** Live prices, per bot instrument; the hub pushes, the beat reads. */
  const [ltp, setLtp] = useState<Record<string, number>>({})

  const botsRef = useRef(bots)
  botsRef.current = bots
  const ltpRef = useRef(ltp)
  ltpRef.current = ltp

  useEffect(() => {
    saveBots(bots)
  }, [bots])

  // The hub socket for the tab's lifetime; every bot's instruments below.
  useEffect(() => {
    tickHub.acquire({ apiKey, wsUrl })
    return () => tickHub.release()
  }, [apiKey, wsUrl])

  const watched = useMemo(() => {
    const list: Array<{ symbol: string; exchange: string }> = []
    for (const bot of bots) {
      list.push(bot.underlying)
      for (const leg of bot.legs) list.push({ symbol: leg.symbol, exchange: leg.exchange })
    }
    if (draft) {
      list.push(draft.underlying)
      for (const leg of draft.legs) list.push({ symbol: leg.symbol, exchange: leg.exchange })
    }
    const seen = new Set<string>()
    return list.filter((item) => {
      const key = `${item.exchange}:${item.symbol}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [bots, draft])

  useEffect(() => {
    const stops = watched.map(({ symbol, exchange }) =>
      tickHub.watch(symbol, exchange, (_s, _e, quote) => {
        setLtp((previous) => ({ ...previous, [`${exchange}:${symbol}`]: quote.ltp }))
      })
    )
    return () => {
      for (const stop of stops) stop()
    }
  }, [watched])

  const patch = useCallback((id: string, next: Partial<StrategyBot>) => {
    setBots((previous) => previous.map((b) => (b.id === id ? { ...b, ...next } : b)))
  }, [])

  // Stable by construction: it reads a ref, so identity is not the point.
  const ltpFor = useCallback(
    (symbol: string, exchange: string): number | undefined =>
      ltpRef.current[`${exchange}:${symbol}`],
    []
  )

  /** The beat's facts for one bot, off the hub's last ticks and the clock. */
  const tickContext = useCallback(
    (bot: StrategyBot): StrategyTickContext => ({
      indexLtp: ltpFor(bot.underlying.symbol, bot.underlying.exchange),
      legLtp: new Map(
        bot.legs
          .map((leg) => [leg.id, ltpFor(leg.symbol, leg.exchange)] as const)
          .filter((pair): pair is readonly [string, number] => pair[1] != null)
      ),
      istSec: istSecondsNow(),
    }),
    [ltpFor]
  )

  /** One multileg batch: every leg, the bot's product and price type. */
  const fireBatch = useCallback(
    async (bot: StrategyBot, action: 'BUY' | 'SELL'): Promise<boolean> => {
      const legs = bot.legs.map((leg) => {
        const live = ltpFor(leg.symbol, leg.exchange)
        return {
          legid: leg.id,
          symbol: leg.symbol,
          exchange: leg.exchange,
          action,
          quantity: leg.lots,
          pricetype: bot.pricetype,
          product: bot.product,
          ...(bot.pricetype === 'LIMIT' && live != null ? { price: live } : {}),
        }
      })
      try {
        const res = await hedgingApi.placeMultileg(apiKey, legs, 'STRATEGY')
        const results = res.results ?? []
        const failed = results.filter((r) => r.status !== 'success')
        if (failed.length === 0) {
          showToast.success(
            `${bot.name}: ${action} ${legs.length} leg${legs.length === 1 ? '' : 's'} placed`
          )
          return true
        }
        showToast.warning(
          `${bot.name}: ${results.length - failed.length}/${legs.length} placed — ${failed
            .map((r) => r.symbol)
            .slice(0, 3)
            .join(', ')}${failed.length > 3 ? '…' : ''} failed`
        )
        return results.length - failed.length > 0
      } catch (e) {
        showToast.error(
          `${bot.name} ${action} failed: ${e instanceof Error ? e.message : 'request error'}`
        )
        return false
      } finally {
        refresh()
      }
    },
    [apiKey, refresh, ltpFor]
  )

  const firingRef = useRef(new Set<string>())
  const verdictsRef = useRef(new Map<string, boolean>())

  // The engine's beat: entry edges, exit reasons, target/stop — one pass per
  // 250ms over the running bots. The ref keeps a fire from doubling while
  // its request is in flight.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const bot of botsRef.current) {
        if (bot.status !== 'watching' && bot.status !== 'open') continue
        if (firingRef.current.has(bot.id)) continue
        const ctx = tickContext(bot)
        if (bot.status === 'watching') {
          const entryKey = `entry:${bot.id}`
          const prevVerdict = verdictsRef.current.get(entryKey) ?? false
          const now = evalConditions(bot.entry, ctx)
          verdictsRef.current.set(entryKey, now)
          if (now && !prevVerdict) {
            firingRef.current.add(bot.id)
            const refs: Record<string, number> = {}
            for (const leg of bot.legs) {
              const live = ltpFor(leg.symbol, leg.exchange)
              if (live != null) refs[leg.id] = live
            }
            void fireBatch(bot, bot.side).then((ok) => {
              firingRef.current.delete(bot.id)
              if (ok)
                patch(bot.id, {
                  status: 'open',
                  openedAt: Date.now(),
                  legEntryRef: refs,
                })
              else patch(bot.id, { status: 'failed', note: 'entry batch refused' })
            })
          }
        } else {
          const reason = exitReason(bot, ctx)
          if (reason) {
            firingRef.current.add(bot.id)
            const exitAction: 'BUY' | 'SELL' = bot.side === 'BUY' ? 'SELL' : 'BUY'
            void fireBatch(bot, exitAction).then((ok) => {
              firingRef.current.delete(bot.id)
              if (ok)
                patch(bot.id, {
                  status: 'completed',
                  closedAt: Date.now(),
                  note: reason === 'conditions' ? undefined : `exit: ${reason} hit`,
                })
              else patch(bot.id, { status: 'failed', note: 'exit batch refused' })
            })
          }
        }
      }
    }, ENGINE_BEAT_MS)
    return () => window.clearInterval(timer)
  }, [fireBatch, patch, tickContext, ltpFor])

  const start = (bot: StrategyBot) => {
    if (refuse()) return
    if (bot.legs.length === 0) {
      showToast.warning('Add at least one strike leg before starting')
      return
    }
    verdictsRef.current.set(`entry:${bot.id}`, false)
    patch(bot.id, { status: 'watching', note: undefined })
  }
  const stop = (bot: StrategyBot) => {
    // An open bot keeps its position: stopping ends the watching, not the trade.
    patch(bot.id, { status: bot.status === 'open' ? 'open' : 'cancelled', note: 'stopped' })
  }
  const exitNow = async (bot: StrategyBot) => {
    if (refuse()) return
    firingRef.current.add(bot.id)
    const ok = await fireBatch(bot, bot.side === 'BUY' ? 'SELL' : 'BUY')
    firingRef.current.delete(bot.id)
    if (ok) patch(bot.id, { status: 'completed', closedAt: Date.now(), note: 'manual exit' })
  }

  const legNameOf = useCallback(
    (bot: StrategyBot) => (legId: string) => bot.legs.find((l) => l.id === legId)?.symbol,
    []
  )

  const startDraft = () => {
    const seed = splitActive(activeSymbol)
    setDraft({
      id: newId(),
      name: 'New bot',
      underlying: seed ?? { symbol: 'NIFTY 50', exchange: 'NSE_INDEX' },
      legs: [],
      side: 'BUY',
      product: 'MIS',
      pricetype: 'MARKET',
      entry: [newCondition('index'), newCondition('time'), newCondition('strike')],
      exit: [newCondition('index')],
      status: 'idle',
    })
  }

  const saveDraft = () => {
    if (!draft) return
    if (draft.legs.length === 0) {
      showToast.warning('A bot needs at least one strike leg')
      return
    }
    setBots((previous) => {
      const at = previous.findIndex((b) => b.id === draft.id)
      if (at >= 0) {
        const next = [...previous]
        next[at] = { ...draft, status: previous[at].status }
        return next
      }
      return [...previous, draft]
    })
    setDraft(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <span className="text-[11px] font-semibold">Strategy bots</span>
        <span className="text-[10px] text-muted-foreground">
          entry / exit on index, strike and clock — AND / OR
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 gap-1 px-2 text-[11px]"
          onClick={startDraft}
        >
          <Plus className="h-3 w-3" /> New bot
        </Button>
      </div>

      {draft && (
        <div className="max-h-[55%] shrink-0 overflow-y-auto border-b bg-muted/30 px-2 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              aria-label="Bot name"
              className="h-7 w-[140px] text-[12px]"
            />
            <UnderlyingPick
              apiKey={apiKey}
              current={draft.underlying}
              onPick={(hit) =>
                setDraft({
                  ...draft,
                  underlying: { symbol: hit.symbol, exchange: hit.exchange },
                })
              }
            />
            <select
              value={draft.underlying.exchange}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  underlying: { ...draft.underlying, exchange: e.target.value },
                })
              }
              aria-label="Underlying exchange"
              className="h-7 rounded border bg-background px-1 text-[12px]"
            >
              {EXCHANGES.map((ex) => (
                <option key={ex} value={ex}>
                  {ex}
                </option>
              ))}
            </select>
            <select
              value={draft.side}
              onChange={(e) => setDraft({ ...draft, side: e.target.value as 'BUY' | 'SELL' })}
              aria-label="Entry side"
              className="h-7 rounded border bg-background px-1 text-[12px]"
            >
              <option value="BUY">BUY legs</option>
              <option value="SELL">SELL legs</option>
            </select>
            <select
              value={draft.product}
              onChange={(e) => setDraft({ ...draft, product: e.target.value as 'MIS' | 'NRML' })}
              aria-label="Product"
              className="h-7 rounded border bg-background px-1 text-[12px]"
            >
              <option value="MIS">MIS</option>
              <option value="NRML">NRML</option>
            </select>
            <select
              value={draft.pricetype}
              onChange={(e) =>
                setDraft({ ...draft, pricetype: e.target.value as 'MARKET' | 'LIMIT' })
              }
              aria-label="Price type"
              className="h-7 rounded border bg-background px-1 text-[12px]"
            >
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT at live price</option>
            </select>
          </div>

          <div className="mt-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Strike legs
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 gap-0.5 px-1 text-[10px]"
                onClick={() =>
                  setDraft({
                    ...draft,
                    legs: [
                      ...draft.legs,
                      {
                        id: newId(),
                        symbol: '',
                        exchange: draft.underlying.exchange.startsWith('NSE_INDEX')
                          ? 'NFO'
                          : draft.underlying.exchange,
                        lots: 75,
                      },
                    ],
                  })
                }
              >
                <Plus className="h-2.5 w-2.5" /> add
              </Button>
            </div>
            {draft.legs.map((leg, i) => (
              <div key={leg.id} className="mt-1 flex items-center gap-1">
                <Input
                  value={leg.symbol}
                  onChange={(e) => {
                    const legs = [...draft.legs]
                    legs[i] = { ...leg, symbol: e.target.value.toUpperCase() }
                    setDraft({ ...draft, legs })
                  }}
                  placeholder="SENSEX29OCT2673800CE"
                  aria-label="Leg symbol"
                  className="h-6 w-[220px] px-1 font-mono text-[11px]"
                />
                <select
                  value={leg.exchange}
                  onChange={(e) => {
                    const legs = [...draft.legs]
                    legs[i] = { ...leg, exchange: e.target.value }
                    setDraft({ ...draft, legs })
                  }}
                  aria-label="Leg exchange"
                  className="h-6 rounded border bg-background px-1 text-[11px]"
                >
                  {EXCHANGES.filter((ex) => ex !== 'NSE_INDEX').map((ex) => (
                    <option key={ex} value={ex}>
                      {ex}
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  value={leg.lots || ''}
                  onChange={(e) => {
                    const legs = [...draft.legs]
                    legs[i] = { ...leg, lots: Math.max(0, Math.floor(Number(e.target.value) || 0)) }
                    setDraft({ ...draft, legs })
                  }}
                  placeholder="qty"
                  aria-label="Leg quantity"
                  className="h-6 w-[70px] px-1 text-[11px] tabular-nums"
                />
                <button
                  type="button"
                  aria-label="Remove leg"
                  onClick={() =>
                    setDraft({ ...draft, legs: draft.legs.filter((l) => l.id !== leg.id) })
                  }
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Entry when
              </span>
              <div className="mt-1 space-y-1">
                {draft.entry.map((cond, i) => (
                  <ConditionRow
                    key={cond.id}
                    cond={cond}
                    legs={draft.legs}
                    first={i === 0}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        entry: draft.entry.map((c) => (c.id === cond.id ? next : c)),
                      })
                    }
                    onRemove={() =>
                      setDraft({ ...draft, entry: draft.entry.filter((c) => c.id !== cond.id) })
                    }
                  />
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-0.5 px-1 text-[10px]"
                  onClick={() => setDraft({ ...draft, entry: [...draft.entry, newCondition()] })}
                >
                  <Plus className="h-2.5 w-2.5" /> condition
                </Button>
              </div>
            </div>
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Exit when
              </span>
              <div className="mt-1 space-y-1">
                {draft.exit.map((cond, i) => (
                  <ConditionRow
                    key={cond.id}
                    cond={cond}
                    legs={draft.legs}
                    first={i === 0}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        exit: draft.exit.map((c) => (c.id === cond.id ? next : c)),
                      })
                    }
                    onRemove={() =>
                      setDraft({ ...draft, exit: draft.exit.filter((c) => c.id !== cond.id) })
                    }
                  />
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-0.5 px-1 text-[10px]"
                  onClick={() => setDraft({ ...draft, exit: [...draft.exit, newCondition()] })}
                >
                  <Plus className="h-2.5 w-2.5" /> condition
                </Button>
              </div>
            </div>
          </div>

          {/* The bot's query, as Start will read it — the preview of what is
              selected, before it is armed. */}
          <div
            role="note"
            aria-label="Condition query preview"
            className="mt-2 rounded border bg-background/60 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-muted-foreground"
          >
            <span className="font-semibold text-foreground">QUERY</span> {draft.side} when{' '}
            {describeConditions(draft.entry, legNameOf(draft))} · exit when{' '}
            {describeConditions(draft.exit, legNameOf(draft))} · {draft.product} · {draft.pricetype}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Target (pts)
              <Input
                type="number"
                value={draft.target ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    target: Number(e.target.value) > 0 ? Number(e.target.value) : undefined,
                  })
                }
                aria-label="Target points"
                className="h-6 w-[70px] px-1 text-[11px] tabular-nums"
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Stop (pts)
              <Input
                type="number"
                value={draft.stoploss ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    stoploss: Number(e.target.value) > 0 ? Number(e.target.value) : undefined,
                  })
                }
                aria-label="Stoploss points"
                className="h-6 w-[70px] px-1 text-[11px] tabular-nums"
              />
            </label>
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setDraft(null)}
              >
                Discard
              </Button>
              <Button size="sm" className="h-6 px-2 text-[11px]" onClick={saveDraft}>
                Save bot
              </Button>
            </span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {bots.length === 0 && !draft && (
          <p className="px-2 py-3 text-[12px] text-muted-foreground">
            No bots yet. A bot watches the index and your strikes, enters when its entry conditions
            come true, and exits on the exit list, a target or a stop.
          </p>
        )}
        {bots.map((bot) => {
          const ctx = tickContext(bot)
          const running = bot.status === 'watching' || bot.status === 'open'
          return (
            <div key={bot.id} className="border-b px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-semibold">{bot.name}</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase',
                    STATUS_TONE[bot.status]
                  )}
                >
                  {bot.status}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {bot.underlying.exchange}:{bot.underlying.symbol} · {bot.legs.length} leg
                  {bot.legs.length === 1 ? '' : 's'} · {bot.side} · {bot.product}
                  {bot.note ? ` · ${bot.note}` : ''}
                </span>
                {running && (
                  <span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {bot.underlying.symbol} {ctx.indexLtp != null ? ctx.indexLtp.toFixed(2) : '—'}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {bot.status === 'idle' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => start(bot)}
                    >
                      Start
                    </Button>
                  )}
                  {running && (
                    <>
                      {bot.status === 'open' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => void exitNow(bot)}
                        >
                          Exit now
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => stop(bot)}
                      >
                        Stop
                      </Button>
                    </>
                  )}
                  {bot.status === 'idle' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setDraft(bot)}
                    >
                      Edit
                    </Button>
                  )}
                  {bot.status !== 'open' && (
                    <button
                      type="button"
                      aria-label={`Delete ${bot.name}`}
                      onClick={() => setBots((previous) => previous.filter((b) => b.id !== bot.id))}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
              {/* The query the bot acts on, in the words the conditions are
                  written in — the same sentence the draft shows before Save. */}
              <div
                role="note"
                aria-label={`${bot.name} condition query`}
                className="mt-0.5 font-mono text-[9.5px] leading-relaxed text-muted-foreground"
              >
                {bot.side} when {describeConditions(bot.entry, legNameOf(bot))} · exit when{' '}
                {describeConditions(bot.exit, legNameOf(bot))}
              </div>
              {running && (
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {bot.legs.map((leg) => {
                    const live = ctx.legLtp.get(leg.id)
                    const ref = bot.legEntryRef?.[leg.id]
                    const points = live != null && ref != null ? live - ref : null
                    return (
                      <span key={leg.id} className="rounded bg-muted px-1 py-0.5">
                        {leg.symbol} {live != null ? live.toFixed(2) : '—'}
                        {points != null && bot.status === 'open' && (
                          <span
                            className={cn(
                              'ml-1',
                              points >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            )}
                          >
                            {points >= 0 ? '+' : ''}
                            {points.toFixed(2)}
                          </span>
                        )}
                      </span>
                    )
                  })}
                  <span className="rounded bg-muted px-1 py-0.5">IST {secToClock(ctx.istSec)}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
