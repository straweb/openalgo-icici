/**
 * The Strategy bots panel: the bottom dock's Strategy tab, moved onto the
 * right rail beside Deploy.
 *
 * The tab is a working surface aimed at one underlying — the focused chart's
 * — with a ladder of armed bots under it, the same shape of thing the Deploy
 * panel is, so it lives on the rail rather than in the books dock. The page
 * hands it the same inputs the dock did: the focused pane's symbol to seed a
 * new bot, the replay lock, and a blotter flush so a fire shows in the books
 * at once (the flush now rides the window event useBlotter listens for,
 * because the dock no longer owns this tab).
 */

import { StrategyTab } from './dock/StrategyTab'
import { PANEL_HEADER, PanelShell } from './panelShell'

interface Props {
  apiKey: string
  wsUrl: string
  activeSymbol: string | null
  refuse(): boolean
  refresh(): void
}

export function StrategyPanel({ apiKey, wsUrl, activeSymbol, refuse, refresh }: Props) {
  return (
    <PanelShell
      id="oa-panel-strategy"
      label="Strategy bots"
      storageKey="oa-trading-strategy-width"
      defaultWidth={400}
    >
      <div className={PANEL_HEADER}>
        <span className="text-[12px] font-medium">Strategy bots</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <StrategyTab
          apiKey={apiKey}
          wsUrl={wsUrl}
          activeSymbol={activeSymbol}
          refuse={refuse}
          refresh={refresh}
        />
      </div>
    </PanelShell>
  )
}
