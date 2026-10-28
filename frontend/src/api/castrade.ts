import { webClient } from './client'

// CAS Trade terminal API. Endpoints are served by blueprints/castrade.py under
// the root path (not /api/v1), so we use webClient (session + CSRF aware).
// The backend replays the cas_prediction strategy timeline (OHLC scoring +
// 15:19/15:20 cross-side confirmation + Cond A + intrinsic projection) over one
// day of 1-minute candles and returns the charts, per-strike analysis and the
// single final winning trade (buy entry_time, sell exit_time).

export interface CastradeUnderlying {
  underlying: string
  fo_exchange: string
  quote_exchange: string
}

export interface CastradeUnderlyingsResponse {
  status: 'success' | 'error'
  message?: string
  data?: CastradeUnderlying[]
}

export interface CastradeExpiryResponse {
  status: 'success' | 'error'
  message?: string
  data?: string[]
}

export interface CastradeCandle {
  time: number // UTC seconds with the IST shift baked in (repo convention)
  open: number
  high: number
  low: number
  close: number
}

export interface CastradeWindowBar {
  ts: number
  o: number
  h: number
  l: number
  c: number
  color: 'green' | 'red' | 'doji' | 'none'
}

export interface CastradeLegActual {
  entry_price: number
  exit_price: number
  pnl_per_unit: number
  pct: number
}

export interface CastradeLeg {
  offset: number // signed strike-ladder steps from ATM (higher strikes = positive)
  moneyness: 'ITM' | 'ATM' | 'OTM' // per-side: CE ITM below spot, PE ITM above
  otm_steps: number // 0 for ITM/ATM, 1..6 for OTM
  strike: number
  side: 'CE' | 'PE'
  symbol: string
  exists: boolean
  tradable: boolean
  score: number // normalized chart score -1..+1 over the window
  verdict: string // STRONG UP / UP / MIXED / DOWN / STRONG DOWN
  flip: boolean // FRESH FLIP: two UP bars after a non-UP base
  blocked: boolean // Cond A side ban
  bar_pattern: CastradeWindowBar | null // 15:19 bar
  bar_decision: CastradeWindowBar | null // 15:20 bar
  premium_at_decision: number | null
  premium_live?: number | null // live session: last tick premium
  projected_pct: number | null
  actual: CastradeLegActual | null
  candles: CastradeCandle[]
  /** live delta only: the newest forming candle of this leg */
  last_candle?: CastradeCandle
}

export interface CastradeCondA {
  base: number | null
  low: number | null
  banned: boolean
  drop_pct: number
}

export interface CastradePattern {
  found: boolean
  reason: string | null
  red_side: 'CE' | 'PE' | null
  mirror_strike?: number
  mirror_side?: 'CE' | 'PE'
  greens?: number[]
  still_green?: number[]
}

export interface CastradeFinalTrade {
  side: 'CE' | 'PE'
  strike: number
  symbol: string
  exchange?: string // live session only (order placement)
  source: 'pattern' | 'scoring'
  reason: string
  entry_time: string
  exit_time: string
  entry_price: number | null
  exit_price: number | null
  pnl_per_unit: number | null
  pct: number | null
  projected_pct: number | null
  lot_size: number
  pending: boolean
}

export interface CastradePreviewPick {
  side: 'CE' | 'PE'
  strike: number
  symbol: string
  source: 'pattern' | 'scoring'
  reason: string | null
}

export interface CastradeOrderRecord {
  time: string
  action: 'BUY' | 'SELL'
  symbol: string
  quantity: number
  lots: number
  product: string
  orderid?: string | null
  status: 'success' | 'failed'
  message?: string | null
}

export interface CastradeFeedStatus {
  connected: boolean
  tick_count: number
  last_tick_age_sec: number | null
  symbols: number
}

export interface CastradeEvent {
  time: string
  text: string
}

export interface CastradeAnalysisData {
  underlying: string
  fo_exchange: string
  quote_symbol: string
  quote_exchange: string
  expiry: string
  trade_date: string
  is_expiry_day: boolean
  mode: 'live' | 'replay'
  atm: number
  strike_step: number
  lot_size: number
  window: {
    start: string
    pattern_bar: string
    decision_bar: string
    entry: string
    exit: string
  }
  spot: {
    at_window_start: number | null
    at_decision: number | null
    projected_exit: number | null
  }
  votes: {
    ce: number
    pe: number
    winning: 'CE' | 'PE' | null
    threshold: number
  }
  cond_a: { CE: CastradeCondA; PE: CastradeCondA }
  pattern: CastradePattern
  final_trade: CastradeFinalTrade | null
  no_trade_reason: string | null
  events: CastradeEvent[]
  legs: CastradeLeg[]
  underlying_candles: CastradeCandle[]
  analyzer_mode: boolean
  // --- live-session extras (absent in replay payloads) ---
  session_id?: string
  live?: boolean
  phase?: 'pre' | 'window' | 'position' | 'done'
  pick_locked?: boolean
  preview_pick?: CastradePreviewPick | null
  preview_source?: 'pattern' | 'scoring' | null
  preview_reason?: string | null
  feed?: CastradeFeedStatus
  orders?: CastradeOrderRecord[]
  position_qty?: number
  server_time?: string
  type?: 'delta'
}

export interface CastradeAnalysisResponse {
  status: 'success' | 'error'
  message?: string
  data?: CastradeAnalysisData
}

export interface CastradeAnalyzeParams {
  underlying: string
  exchange: string
  expiry: string
  trade_date?: string
  window_start?: string
  entry_time?: string
  exit_time?: string
}

export const castradeApi = {
  getUnderlyings: async (): Promise<CastradeUnderlyingsResponse> => {
    const response = await webClient.get<CastradeUnderlyingsResponse>('/castrade/api/underlyings')
    return response.data
  },

  getExpiry: async (underlying: string, exchange: string): Promise<CastradeExpiryResponse> => {
    const response = await webClient.get<CastradeExpiryResponse>('/castrade/api/expiry', {
      params: { underlying, exchange },
    })
    return response.data
  },

  analyze: async (params: CastradeAnalyzeParams): Promise<CastradeAnalysisResponse> => {
    const response = await webClient.post<CastradeAnalysisResponse>('/castrade/api/analyze', params)
    return response.data
  },

  // --- live tick-by-tick session ---

  liveStart: async (params: CastradeAnalyzeParams): Promise<CastradeAnalysisResponse> => {
    const response = await webClient.post<CastradeAnalysisResponse>(
      '/castrade/api/live/start',
      params
    )
    return response.data
  },

  liveStop: async (): Promise<{ status: string; message?: string }> => {
    const response = await webClient.post('/castrade/api/live/stop')
    return response.data
  },

  liveState: async (
    full = false
  ): Promise<{ status: 'success' | 'error'; message?: string; data?: CastradeAnalysisData }> => {
    const response = await webClient.get('/castrade/api/live/state', {
      params: full ? { full: 1 } : undefined,
    })
    return response.data
  },

  // --- orders (live session only, locked final pick only) ---

  placeOrder: async (params: {
    action: 'BUY' | 'SELL'
    symbol: string
    lots: number
    product?: string
  }): Promise<{ status: 'success' | 'error'; message?: string; orderid?: string }> => {
    const response = await webClient.post('/castrade/api/order', params)
    return response.data
  },
}
