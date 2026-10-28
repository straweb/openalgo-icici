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
  offset: number // -1..4 relative to ATM
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
  projected_pct: number | null
  actual: CastradeLegActual | null
  candles: CastradeCandle[]
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
}
