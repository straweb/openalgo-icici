# CAS Trade (`/castrade`) — User Guide

The expiry-day closing-window terminal for the **cas_prediction** strategy:
watch the last minutes of the expiry session tick by tick, let the engine
conclude ONE strike, and fire the real BUY / SELL orders on your broker with
two buttons.

Open it from the sidebar: **CAS Trade** (`/castrade`).

---

## 1. Before you start

1. **Broker connected.** Log in to your broker through OpenAlgo (Broker Login) and make sure the websocket feed is working — live ticks come from the broker feed.
2. **API key generated.** Settings → API Key (`/apikey`). The page uses it internally; without it the terminal will refuse to run.
3. **Expiry day.** The strategy is built for expiry-day behaviour; pick the underlying's **today** expiry in the dropdown (it sorts soonest first).
4. Optional safety net: Settings → turn **Analyzer Mode** ON while learning. Every "real" order then lands in the sandbox instead of the broker — same flow, zero risk.

## 2. The toolbar

| Control | What it does |
|---|---|
| Underlying / Expiry | What to trade. Any index or F&O symbol on NFO/BFO/MCX/CDS. |
| Trade date | Today for live; any past date for replay studies. |
| **Analyze** | REPLAY mode: runs the whole timeline on that day's 1-minute candles. Read-only, safe. |
| **Go Live** | LIVE mode: starts the tick-by-tick session (see §4). This is the trading mode. |
| **Stop Live** | Ends the live session and unsubscribes the feed symbols. |
| Auto 60s | Re-runs the replay every minute while a *replay* of today is on screen (live sessions stream on their own). |
| LIVE TICKS / FEED badge | Session state. `FEED n ticks` = broker feed healthy; `FEED OFFLINE` = no ticks arriving (check broker feed/login). |
| Spot strip | Spot at window start → now → projected exit, side votes, pattern state, session phase and the preview/locked pick. |

## 3. Reading the screen

**Left — charts (CE column left, PE column right).** Every strike of the
universe has its own 1-minute chart. Each side shows exactly
**1 ITM + ATM + 6 OTM** strikes (CE: ITM is ATM−1; PE: ITM is ATM+1 — the
mirrored layout keeps both sides OTM-heavy by design). Charts are ordered ITM,
ATM, then OTM+1…OTM+6. The dots on each chart are the 15:19 and 15:20 candles
of the cross-side rule; the winning leg gets BUY/SELL arrows.

**Right — Strikes panel.** One row per leg: moneyness tag, strike, the
15:19/15:20 dot colours, the normalized score, the live premium, the projected
% and (in replay/past sessions) the actual %. The **CE | PE divider** splits the
sides; Cond A badges show a banned side; the winner row is highlighted.

**Right — Final Trade panel.**
- While the window is still forming (live): the **FORMING** preview card — the
  pick the engine currently sees, updating tick by tick. Nothing is tradable yet.
- After the 15:20 bar closes: the **locked final trade** — the ONE strike to
  buy, with entry/exit prices, projected/actual return, P&L and the
  **BUY** and **SELL** buttons.
- NO TRADE card when the engine found no qualified entry — that is a valid
  daily outcome, not an error.

**Right — Timeline.** The engine's decision log: window open, Cond A events,
cross-side scan result, side votes, the pick and the lock, your orders.

## 4. Live tick-by-tick session (the trading flow)

Press **Go Live** (around 15:10–15:14, before the window opens):

1. The backend seeds today's candles, then subscribes the underlying + all 16 legs to the broker websocket feed (LTP ticks).
2. Every tick updates the **forming** 1-minute bar of its symbol — charts, scores, votes and the pattern preview move tick by tick, no waiting for the minute to close.
3. Updates stream into the page as socket.io events (a 5-second poll keeps it honest if the socket drops).
4. The moment the **15:20 bar closes** the pick **LOCKS**. The spot strip shows `LOCKED <side> <strike>` and the BUY button arms.
5. **BUY** arms at 15:21, **SELL** arms once the BUY filled (position line shows your open qty).
6. After 15:30 the session winds down and stays reviewable for ~15 minutes (charts keep the actual outcome), then it expires.

Feed badge says OFFLINE? The session still runs on seeded history (useful for
studies), but tick-by-tick behaviour and order arming need the broker feed —
reconnect the broker feed and press **Go Live** again.

## 5. Placing the real orders

1. Set **lots** (1–20) in the Final Trade panel. Quantity = lots × contract lot size, enforced server-side.
2. **BUY** → a confirmation dialog shows action, lots, quantity, symbol and MARKET/MIS → confirm. The order goes through OpenAlgo's standard order pipeline (same as the REST API), tagged with strategy `castrade`.
3. A toast confirms the order with its broker order ID; the panel shows the order line and your open quantity.
4. **SELL** exits the position — the same MARKET order in the opposite direction. The button only arms while a page-opened position exists.
5. Safety rails you cannot bypass from the UI:
   - only the **locked final pick** symbol is tradable on this page;
   - BUY only inside the entry→exit window and only one open position;
   - whole lots, ≤ 20 lots per click;
   - Analyzer Mode ON ⇒ orders land in the sandbox, not the broker.

The page does **not** auto-trade. The engine decides *what*; you decide *when*
to press. If you prefer automation later, the same pick is exposed on
`GET /castrade/api/live/state` for your own bot.

## 6. Replay mode (study & verification)

Pick a past expiry date and press **Analyze**: the exact same engine replays
that day — charts, votes, pattern scan, the final pick and the ACTUAL
entry/exit outcome per strike (the `Real` column). Use it to verify the
strategy on history before trusting it live.

## 7. The strategy in one paragraph

From 15:15 the engine scores every leg by candle-vs-candle OHLC transitions
(UP/DOWN/INSIDE/OUTSIDE + close confirmations, recency-weighted, no
indicators). Cond A bans any side whose near-ATM premium basket crashed ≥50%
in the window. A side "wins" only when its vote > +0.30 against the other
side < −0.30. The **15:19/15:20 cross-side rule** outranks everything: near-ATM
red while siblings are green at 15:19, still green at 15:20 ⇒ buy the mirror
strike on the opposite side. Without the pattern, the vote-winner's best
projected strike wins (projection = intrinsic at `spot + avg_gain × 8 × 0.35`).
The pick locks at 15:21, BUY MARKET at the 15:21 open, SELL MARKET at the
15:29 open. Details with exact numbers: `docs/castrade/LOGIC.md`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "API key not configured" | Generate one at `/apikey`, then reload the page. |
| "No spot reference available" | The broker feed/history for the index is down — check broker login and try again. |
| "No option candles available for the window" | The broker doesn't serve 1-minute history for those option symbols that day. Try a different date/broker or run live mode only. |
| FEED OFFLINE badge | Websocket feed not connected: re-login the broker, verify the feed (websocket proxy port), then Go Live again. |
| "The final pick is not locked yet" on BUY | Wait for the 15:20 bar to close — buttons arm only after the lock. |
| "This page only trades the final pick" | You tried to trade a strike other than the locked one — by design. |
| BUY says "Entry window closed" | Past the exit time; the trade window is over. |
| Charts flat / missing some OTM legs | Those strikes had no ticks/that ladder edge doesn't exist; harmless — the engine skips legs without data. |
| Order rejected | Read the toast — broker margin, freeze limit or product issues surface there; the order pipeline logs the full response under Traffic Logs. |
