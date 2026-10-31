QuantDesk (v16) — quanttrade terminal page for OpenAlgo
========================================================

WHAT
----
New page at /quantdesk — cloned quanttrade UI (canvas chart with ghost
overlay/drawings/indicators, workspace tabs, watchlist, strikes desk with
quick deploy, order pad), wired to OpenAlgo REST (/api/v1) + the ws proxy.
Top bar (logo, workspace tabs, underlying+series picker defaulting to spot
index + latest expiry, page menu). Layouts 1 / S+2 / 2x2 / T+1 / T+2 / L+1 /
L+2 (flexible resize). Right widget tabs: Chart info (strikes desk + next
expiry), Watchlist, Strategy bot, Constituents, Option chain, Alerts,
Data objects. Action bar: session capital, order settings, strikes
quick-deploy, deploy-by-level + schedule (IST, once/daily). Bottom dock
reuses OpenAlgo's TradingDock: positions, orders, trade, GTT, Schedule,
depth. Chart extras added on top of quanttrade: goto DATETIME (calendar +
HH:MM IST), chart types bars + heikin ashii, indicators Supertrend(10,3),
Donchian(20), EMA200.

INSTALL
-------
unzip -o quantdesk_v16_changes.zip -d <repo root>
(the -o is REQUIRED — plain unzip may skip/ask on existing files like
App.tsx and index.css)

then:
  npm install          (new dep: @radix-ui/react-slider)
Restart backend not required (frontend-only change), but rebuild:
  cd frontend && npm run build
Hard-refresh the browser (Ctrl+Shift+R).

Route: http://<host>/quantdesk (login first).

FILES
-----
30 files + this README, at zip root:

  frontend/src/components/quantdesk/chart/canvas-chart.tsx
  frontend/src/components/quantdesk/lib/chartMarkers.ts
  frontend/src/components/quantdesk/lib/client-api.ts
  frontend/src/components/quantdesk/lib/rsp-compat.tsx
  frontend/src/components/quantdesk/lib/schedule.ts
  frontend/src/components/quantdesk/lib/socket.ts
  frontend/src/components/quantdesk/lib/store.ts
  frontend/src/components/quantdesk/lib/sync.ts
  frontend/src/components/quantdesk/lib/types.ts
  frontend/src/components/quantdesk/panels/option-mini-charts.tsx
  frontend/src/components/quantdesk/panels/option-panes.tsx
  frontend/src/components/quantdesk/panels/order-pad.tsx
  frontend/src/components/quantdesk/panels/strikes-panel.tsx
  frontend/src/components/quantdesk/panels/watchlist.tsx
  frontend/src/components/quantdesk/widgets/ActionBar.tsx
  frontend/src/components/quantdesk/widgets/Alerts.tsx
  frontend/src/components/quantdesk/widgets/ChartsPane.tsx
  frontend/src/components/quantdesk/widgets/DataObjects.tsx
  frontend/src/components/quantdesk/widgets/RightWidgets.tsx
  frontend/src/components/quantdesk/widgets/TerminalView.tsx
  frontend/src/components/quantdesk/widgets/TopBar.tsx
  frontend/src/components/quantdesk/widgets/UnderlyingPicker.tsx
  frontend/src/components/quantdesk/widgets/WorkspaceTabs.tsx
  frontend/src/components/quantdesk/widgets/scheduler.ts
  frontend/src/pages/QuantDesk.tsx
  frontend/src/components/ui/slider.tsx
  frontend/src/App.tsx
  frontend/src/index.css
  frontend/package.json
  frontend/package-lock.json

NOTES
-----
- Adapter module frontend/src/components/quantdesk/lib/client-api.ts maps
  quanttrade's API surface to OpenAlgo endpoints
  (history/quotes/depth/optionchain/placeorder/...).
- lib/socket.ts speaks OpenAlgo's ws-proxy protocol
  (authenticate/subscribe mode 2).
- lib/sync.ts polls order/position/trade books every 4s and chains every 6s.
- localStorage keys prefixed oa-qd- / oa-quantdesk-.
- Scheduled quantdesk deploys live in the action bar popover (separate from
  the hedging scheduler book).
