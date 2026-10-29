/**
 * The strategy bot: condition-driven entry and exit over live ticks.
 *
 * A bot is a pair of condition lists — entry and exit — over three kinds of
 * fact: the underlying index's last price, one leg's premium (a strike the
 * bot carries), and the IST clock read to the second. Conditions join
 * left-to-right, each carrying its own AND/OR against the one before it, so
 * "sensex < 73800 AND time 11:00–11:30 AND 73800 CE < 400" and the exit's
 * "sensex > 73800 OR time < 11:00" both read the way they are written. The
 * evaluation is deliberately flat — no precedence, parentheses are the row
 * order — because a trader reading the list reads it top to bottom.
 *
 * The lifecycle is one cycle per Start: idle → watching (entry armed) → the
 * entry conditions pass once (edge-triggered, so a live bot does not re-fire
 * on every beat) → open (the legs' orders are in) → the exit conditions pass
 * or a target/stop on the entry reference is hit → the legs close → done.
 * Stop halts a watching bot where it stands; an open bot stops watching but
 * leaves its position to the trader, which the positions tab squares off.
 *
 * The module is pure: it knows conditions, not components. The tab feeds it
 * a tick snapshot and reads back what to do.
 */

/** The three facts a condition can read. */
export type StrategyField = 'index' | 'strike' | 'time'

/** Ordered comparisons; `between` is the inclusive range only time uses. */
export type StrategyCompare = '<' | '<=' | '>' | '>=' | 'between'

export interface StrategyCondition {
  id: string
  /** The joiner against the condition ABOVE this one; the first row's is ignored. */
  join: 'and' | 'or'
  field: StrategyField
  op: StrategyCompare
  /** A price, a premium, or — for time — seconds from IST midnight. */
  value: number
  /** `between`'s upper bound; ignored otherwise. */
  value2?: number
  /** For `strike`: which leg's premium the comparison reads. */
  legId?: string
}

export interface StrategyLeg {
  id: string
  symbol: string
  exchange: string
  lots: number
}

export type StrategyStatus = 'idle' | 'watching' | 'open' | 'completed' | 'cancelled' | 'failed'

export interface StrategyBot {
  id: string
  name: string
  /** The index whose LTP `index` conditions read. */
  underlying: { symbol: string; exchange: string }
  legs: StrategyLeg[]
  side: 'BUY' | 'SELL'
  product: 'MIS' | 'NRML'
  pricetype: 'MARKET' | 'LIMIT'
  entry: StrategyCondition[]
  exit: StrategyCondition[]
  /** Premium points from the entry reference; both optional, both per leg. */
  target?: number
  stoploss?: number
  status: StrategyStatus
  openedAt?: number
  closedAt?: number
  /** The premium each leg traded through at the entry fire, for target/SL. */
  legEntryRef?: Record<string, number>
  note?: string
}

/** One evaluation beat's facts: the hub's snapshots and the clock. */
export interface StrategyTickContext {
  indexLtp?: number
  /** Leg symbol → live premium. */
  legLtp: ReadonlyMap<string, number>
  /** Seconds from IST midnight, the clock the time conditions read. */
  istSec: number
}

export interface StrategyLegRef {
  symbol: string
  exchange: string
  lots: number
}

/** IST is UTC+5:30, with no DST — a fixed offset is the whole rule. */
export const IST_OFFSET_SEC = 5.5 * 3600

/** The current IST clock as seconds from midnight. */
export function istSecondsNow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 + IST_OFFSET_SEC) % 86400
}

/** Parse HH:MM(:SS)? into seconds from midnight; null when it does not read. */
export function parseClockToSec(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || s > 59) return null
  return h * 3600 + min * 60 + s
}

/** Seconds from midnight back to HH:MM:SS, the form the inputs show. */
export function secToClock(sec: number): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(r)}`
}

function compare(op: StrategyCompare, v: number, value: number, value2?: number): boolean {
  switch (op) {
    case '<':
      return v < value
    case '<=':
      return v <= value
    case '>':
      return v > value
    case '>=':
      return v >= value
    case 'between':
      return value2 != null && v >= Math.min(value, value2) && v <= Math.max(value, value2)
  }
}

/**
 * Evaluate one condition against the beat's facts. A condition whose fact is
 * missing — the index quote has not landed, the leg has not ticked — is
 * false, never an error: a bot watches until the market answers.
 */
export function evalCondition(cond: StrategyCondition, ctx: StrategyTickContext): boolean {
  if (cond.field === 'time') return compare(cond.op, ctx.istSec, cond.value, cond.value2)
  if (cond.field === 'index') {
    if (ctx.indexLtp == null) return false
    return compare(cond.op, ctx.indexLtp, cond.value)
  }
  // strike: reads the leg the condition names.
  const leg = cond.legId ? ctx.legLtp.get(cond.legId) : undefined
  if (leg == null) return false
  return compare(cond.op, leg, cond.value)
}

/**
 * The list's verdict, joined left to right. An empty list is never true — a
 * bot with no entry conditions has nothing to say about entering.
 */
export function evalConditions(
  conds: readonly StrategyCondition[],
  ctx: StrategyTickContext
): boolean {
  if (conds.length === 0) return false
  let acc = evalCondition(conds[0], ctx)
  for (let i = 1; i < conds.length; i++) {
    const cond = conds[i]
    const value = evalCondition(cond, ctx)
    acc = cond.join === 'or' ? acc || value : acc && value
  }
  return acc
}

/** The exit's own conditions, or the target/stop riding the entry reference. */
export function exitReason(
  bot: StrategyBot,
  ctx: StrategyTickContext
): 'conditions' | 'target' | 'stoploss' | null {
  if (evalConditions(bot.exit, ctx)) return 'conditions'
  const refs = bot.legEntryRef ?? {}
  const dir = bot.side === 'BUY' ? 1 : -1
  for (const leg of bot.legs) {
    const ref = refs[leg.id]
    const ltp = ctx.legLtp.get(leg.id)
    if (ref == null || ltp == null) continue
    const points = (ltp - ref) * dir
    if (bot.target != null && bot.target > 0 && points >= bot.target) return 'target'
    if (bot.stoploss != null && bot.stoploss > 0 && points <= -bot.stoploss) return 'stoploss'
  }
  return null
}

/**
 * Whether the entry list just crossed from unmet to met. The caller passes
 * the previous beat's verdict; the fire happens on the edge, not on the level,
 * so a bot that entered does not re-enter while its conditions hold.
 */
export function entryEdge(bot: StrategyBot, ctx: StrategyTickContext, previous: boolean): boolean {
  const now = evalConditions(bot.entry, ctx)
  return now && !previous
}

/* ── persistence ──────────────────────────────────────────────────────────── */

const STORE_KEY = 'oa-trading-strategy-bots'

function sanitize(raw: unknown): StrategyBot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Partial<StrategyBot>
  if (typeof b.id !== 'string' || typeof b.name !== 'string') return null
  if (typeof b.underlying?.symbol !== 'string') return null
  if (!Array.isArray(b.legs) || !Array.isArray(b.entry) || !Array.isArray(b.exit)) return null
  // Built field by field rather than spread over the Partial: a spread keeps
  // every property optional in the type's eyes, and the result would not
  // read back as the StrategyBot the rest of the module indexes into.
  const bot: StrategyBot = {
    id: b.id,
    name: b.name,
    underlying: {
      symbol: b.underlying.symbol,
      exchange: typeof b.underlying.exchange === 'string' ? b.underlying.exchange : 'NSE_INDEX',
    },
    legs: b.legs as StrategyLeg[],
    side: b.side === 'SELL' ? 'SELL' : 'BUY',
    product: b.product === 'NRML' ? 'NRML' : 'MIS',
    pricetype: b.pricetype === 'LIMIT' ? 'LIMIT' : 'MARKET',
    entry: b.entry as StrategyCondition[],
    exit: b.exit as StrategyCondition[],
    status: (['idle', 'watching', 'open', 'completed', 'cancelled', 'failed'] as const).includes(
      b.status as StrategyStatus
    )
      ? (b.status as StrategyStatus)
      : 'idle',
  }
  if (typeof b.target === 'number') bot.target = b.target
  if (typeof b.stoploss === 'number') bot.stoploss = b.stoploss
  if (typeof b.openedAt === 'number') bot.openedAt = b.openedAt
  if (typeof b.closedAt === 'number') bot.closedAt = b.closedAt
  if (b.legEntryRef != null && typeof b.legEntryRef === 'object') bot.legEntryRef = b.legEntryRef
  if (typeof b.note === 'string') bot.note = b.note
  return bot
}

/** A page reload parks every running bot back at idle: the ticks stopped. */
export function loadBots(): StrategyBot[] {
  try {
    const raw = globalThis.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(sanitize)
      .filter((b): b is StrategyBot => b !== null)
      .map((b) => (b.status === 'watching' || b.status === 'open' ? { ...b, status: 'idle' } : b))
  } catch {
    return []
  }
}

export function saveBots(bots: readonly StrategyBot[]): void {
  try {
    globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(bots))
  } catch {
    // Storage refused: the bots live for this visit.
  }
}

export function newId(): string {
  return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** A fresh condition row: index price under a blank the trader fills. */
export function newCondition(field: StrategyField = 'index'): StrategyCondition {
  return { id: newId(), join: 'and', field, op: '<', value: 0 }
}
