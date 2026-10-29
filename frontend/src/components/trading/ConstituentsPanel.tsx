/**
 * The Constituents panel: the bottom dock's Constituents tab (the id stays
 * 'index', as it did through the tab's own rename), moved onto the right
 * rail beside Deploy.
 *
 * The table follows one underlying — resolved from the deploy binding, then
 * the focused chart, then any open chart — and its level deploy fires onto
 * this page's ladder, so it is a working surface for the focused instrument
 * rather than a book over every symbol. That is the rail's company, not the
 * dock's.
 */

import type { SearchRow } from '@/lib/trading/terminal'
import { IndexTab } from './dock/IndexTab'
import { PANEL_HEADER, PanelShell } from './panelShell'

interface Props {
  apiKey: string
  activeSymbol: string | null
  paneSymbols: Record<string, string | null>
  onPick(row: SearchRow): void
}

export function ConstituentsPanel({ apiKey, activeSymbol, paneSymbols, onPick }: Props) {
  return (
    <PanelShell
      id="oa-panel-index"
      label="Constituents"
      storageKey="oa-trading-index-width"
      defaultWidth={380}
    >
      <div className={PANEL_HEADER}>
        <span className="text-[12px] font-medium">Constituents</span>
      </div>
      {/* Full height, no scroll of its own: the tab's table owns the panel's
          one scrollbar, and only when the rows ask for it. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <IndexTab
          apiKey={apiKey}
          activeSymbol={activeSymbol}
          paneSymbols={paneSymbols}
          onPick={onPick}
        />
      </div>
    </PanelShell>
  )
}
