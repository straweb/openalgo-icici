import { BarChart3, Bell, Boxes, Layers, ListTree, Search, Shapes, Table2 } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import type { SearchRow } from '@/lib/trading/terminal'
import { api, registerExchange } from '../lib/client-api'
import type { WorkspaceCfg } from '../lib/store'
// Panels from the quanttrade port
import { NextStrikes, StrikesPanel } from '../panels/strikes-panel'
import { Watchlist } from '../panels/watchlist'
import { QuantDeskAlerts } from './Alerts'
import { QuantDeskDataObjects } from './DataObjects'

// OpenAlgo widgets (lazy — each carries its own data plumbing)
const StrategyTab = lazy(() =>
  import('@/components/trading/dock/StrategyTab').then((m) => ({ default: m.StrategyTab }))
)
const IndexTab = lazy(() =>
  import('@/components/trading/dock/IndexTab').then((m) => ({ default: m.IndexTab }))
)
const OptionChainPanel = lazy(() =>
  import('@/components/trading/OptionChainPanel').then((m) => ({ default: m.OptionChainPanel }))
)

// ============================================================
// Right widget dock. Tabs (top, scrolling horizontally):
//   Chart info (strikes desk) · Watchlist · Strategy bot ·
//   Constituents · Option chain · Alerts · Data objects
// ============================================================

export type QdRightTab =
  | 'chartinfo'
  | 'watchlist'
  | 'strategy'
  | 'constituents'
  | 'chain'
  | 'alerts'
  | 'data'

const TABS: { id: QdRightTab; label: string; icon: typeof ListTree; tip: string }[] = [
  {
    id: 'chartinfo',
    label: 'Chart info',
    icon: ListTree,
    tip: 'Strikes desk for the workspace underlying (add strikes, deploy, manage)',
  },
  {
    id: 'watchlist',
    label: 'Watchlist',
    icon: Search,
    tip: 'Watch, indices, F&O universe, search — click a row to open its workspace',
  },
  { id: 'strategy', label: 'Bot', icon: Boxes, tip: 'Strategy bots' },
  {
    id: 'constituents',
    label: 'Constituents',
    icon: Layers,
    tip: 'Index constituents — who moves the index',
  },
  { id: 'chain', label: 'Chain', icon: Table2, tip: 'Full option chain' },
  { id: 'alerts', label: 'Alerts', icon: Bell, tip: 'Price alerts on the live feed' },
  {
    id: 'data',
    label: 'Data',
    icon: Shapes,
    tip: 'Data objects of the selected chart — crosshair OHLCV, drawings',
  },
]

interface Props {
  ws: WorkspaceCfg
  apiKey: string
  wsUrl: string
  /** Focused pane settingsKey — the Data objects tab reads it. */
  focusedPaneKey: string | null
  /** Chart a picked row (watchlist/dock/chain). */
  onPick(row: SearchRow): void
}

export function RightWidgets({ ws, apiKey, wsUrl, focusedPaneKey, onPick }: Props) {
  const [tab, setTab] = useState<QdRightTab>('chartinfo')
  const activeSymbol = ws ? `${wsSymbolExchange(ws.symbol)}:${ws.symbol}` : null

  return (
    <div className="h-full flex flex-col border-l border-border">
      {/* tab strip */}
      <div className="flex items-center gap-0.5 px-1 py-1 border-b border-border bg-card/30 overflow-x-auto shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            title={t.tip}
            className={`flex items-center gap-1 px-1.5 py-1 rounded text-[10px] whitespace-nowrap ${
              tab === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            <t.icon className="h-3 w-3" />
            <span className="hidden 2xl:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'chartinfo' && <ChartInfo ws={ws} />}
        {tab === 'watchlist' && <Watchlist />}
        {tab === 'strategy' && (
          <Suspense fallback={<PaneLoading label="Strategy bots" />}>
            <div className="h-full overflow-y-auto">
              <StrategyTab
                apiKey={apiKey}
                wsUrl={wsUrl}
                activeSymbol={activeSymbol}
                refuse={() => false}
                refresh={() => window.dispatchEvent(new CustomEvent('oa:blotter-refresh'))}
              />
            </div>
          </Suspense>
        )}
        {tab === 'constituents' && (
          <Suspense fallback={<PaneLoading label="Constituents" />}>
            <div className="h-full overflow-y-auto">
              <IndexTab
                apiKey={apiKey}
                activeSymbol={activeSymbol}
                paneSymbols={{ [ws.id]: activeSymbol }}
                onPick={onPick}
              />
            </div>
          </Suspense>
        )}
        {tab === 'chain' && (
          <Suspense fallback={<PaneLoading label="Option chain" />}>
            <OptionChainPanel apiKey={apiKey} activeSymbol={activeSymbol} onPick={onPick} />
          </Suspense>
        )}
        {tab === 'alerts' && <QuantDeskAlerts activeSymbol={ws.symbol} />}
        {tab === 'data' && <QuantDeskDataObjects paneKey={focusedPaneKey} />}
      </div>
    </div>
  )
}

/** Chart info = the strikes desk with a Desk/Next-expiry mini switch. */
function ChartInfo({ ws }: { ws: WorkspaceCfg }) {
  const [sub, setSub] = useState<'desk' | 'next'>('desk')
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60 shrink-0">
        <button
          type="button"
          onClick={() => setSub('desk')}
          className={`px-1.5 py-0.5 rounded text-[10px] ${sub === 'desk' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          title="Your added strikes desk"
        >
          Desk
        </button>
        <button
          type="button"
          onClick={() => setSub('next')}
          className={`px-1.5 py-0.5 rounded text-[10px] ${sub === 'next' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          title="Next-expiry strikes browser"
        >
          Next expiry
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {sub === 'desk' ? <StrikesPanel ws={ws} /> : <NextStrikes ws={ws} />}
      </div>
    </div>
  )
}

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="h-full grid place-items-center text-[11px] text-muted-foreground gap-1">
      <BarChart3 className="h-4 w-4 animate-pulse" />
      Loading {label}…
    </div>
  )
}

/** Exchange prefix for pane-style `EXCHANGE:SYMBOL` keys. */
export function wsSymbolExchange(symbol: string): string {
  const known: Record<string, string> = {
    NIFTY: 'NSE',
    FINNIFTY: 'NSE',
    MIDCPNIFTY: 'NSE',
    NIFTYNXT50: 'NSE',
    SENSEX: 'BSE',
    BANKEX: 'BSE',
  }
  if (known[symbol.toUpperCase()]) return known[symbol.toUpperCase()]
  if (/(CE|PE|FUT)$/.test(symbol.toUpperCase())) {
    const root = symbol.replace(/(\d{2}[A-Z]{3}\d{2,4})?\d*(CE|PE|FUT)$/i, '').toUpperCase()
    if (root === 'SENSEX' || root === 'BANKEX' || root === 'SENSEX50') return 'BFO'
    void api
    return 'NFO'
  }
  registerExchange(symbol, 'NSE')
  return 'NSE'
}
