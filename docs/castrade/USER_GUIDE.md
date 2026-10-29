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

**Left — TWO live canvases (CE card, PE card).** Instead of a grid of per-strike
charts there is one custom canvas per side. Each canvas draws its side's
representative leg's candles **tick by tick** (the forming bar repaints in
place as broker ticks arrive), with vertical markers for the 15:19 / 15:20
pattern bars and the entry/exit times, and a gold last-price line. The card
header shows the side vote, the Cond A state and the side's current
**PREDICT** chip — the strike the engine currently projects for a positive
return (locked pick > forming preview > best projected leg), with its
projected %. The row under the header shows the drawn leg's verdict, x/20
confidence, premium and the 19/20 dot colours.

**Strike universe — SEVEN strikes on one ladder.** 3 strikes BELOW + the
baseline ATM + 3 strikes ABOVE the 15:15 baseline spot, each strike with a CE
and a PE leg (14 legs total). Moneyness labels are per-side: CE ATM = the
strike at/below the spot, PE ATM = the strike at/above the spot (e.g. spot
22760.75 → CE ATM 22750, PE ATM 22800 — both visible on the same ladder
22600..22900). The toolbar strip shows both ATMs (`ATM CE x · PE y`).

**Right — resizable Strikes panel.** Drag the divider between the charts and
the panel to resize it (280–720 px, remembered across reloads; focus it and
use the arrow keys for keyboard resizing). One row per leg: moneyness tag,
strike, the 15:19/15:20 dot colours, the normalized score, an **x/20
confidence** read, the live premium, the projected % and (in replay/past
sessions) the actual %. The **CE | PE divider** splits the sides; Cond A
badges mark a banned side; the winner row shows WIN and the engine's current
positive-return projections show a **PRED** badge.

**Quick B/S buttons (live mode).** Every strike row ends with a green **B** and
a red **S** button — a quick way to buy or sell THAT strike at the Lots stepper
size, without waiting for the lock. A small amber count shows qty you already
hold in that strike from this page. SELL is only enabled while you hold it.

**Right — Final Trade panel.**
- While the window is still forming (live): the **FORMING** preview card — the
  pick the engine currently sees, updating tick by tick. Nothing is tradable yet.
- After the 15:20 bar closes: the **locked final trade** — the ONE strike to
  buy, with entry/exit prices, projected/actual return, P&L and the
  **BUY** and **SELL** buttons.
- NO TRADE card when the engine found no qualified entry — that is a valid
  daily outcome, not an error.

**Right — Funds % slider (just below the Final Trade panel).** Reads your
broker's available funds and sizes orders by percentage of that amount: drag
1–100%, it shows the deployable amount and the whole-lot equivalent at the
final pick's premium; **Apply** syncs the Lots stepper (1–20 cap). The quick
B/S buttons use the same Lots value. The slider never orders by itself.

**Right — Timeline.** The engine's decision log: window open (with the
per-side ATMs), Cond A events, the cross-side scan result, side votes, the
pick and the lock, your orders.

**Toolbar times.** The window start, entry (lock) and exit times are editable
time inputs. The exit must be AFTER the entry — a stale saved exit of 15:20
with entry 15:21 used to silently disarm every order button; the page and the
backend now reject that combination up front (the times are stored under a new
key, so old broken values are reset once).

## 4. Live tick-by-tick session (the trading flow)

Press **Go Live** (around 15:10–15:14, before the window opens):

1. The backend seeds today's candles, then subscribes the underlying + all 14 legs to the broker websocket feed (LTP ticks).
2. Every tick updates the **forming** 1-minute bar of its symbol — the two side canvases, scores, votes and the pattern preview move tick by tick, no waiting for the minute to close.
3. Every engine pass is **pushed to the page** as a socket.io `castrade_update` event (a 5-second poll keeps it honest if the socket drops) — charts repaint on the push, no re-analysis needed.
4. The moment the **15:20 bar closes** the pick **LOCKS**. The spot strip shows `LOCKED <side> <strike>` and the BUY button arms.
5. **BUY** arms at 15:21, **SELL** arms once the BUY filled (position line shows your open qty).
6. After 15:30 the session winds down and stays reviewable for ~15 minutes, then it expires.

Feed badge says OFFLINE? The session still runs on seeded history (useful for
studies), but tick-by-tick behaviour and order arming need the broker feed —
reconnect the broker feed and press **Go Live** again.

## 5. Placing the real orders

1. Set **lots** (1–20) in the Final Trade panel — or drag the **Funds %** slider below it and press **Apply** to size lots from your available funds (`lots = available × % ÷ (premium × lot size)`).
2. **BUY** (final pick) → a confirmation dialog shows action, lots, quantity, symbol and MARKET/MIS → confirm. The order goes through OpenAlgo's standard order pipeline (same as the REST API), tagged with strategy `castrade`.
3. A toast confirms the order with its broker order ID; the panel shows the order line and your open quantity.
4. **SELL** exits the position — the same MARKET order in the opposite direction. The button only arms while a page-opened position exists.
5. **Quick B/S on any strike row** (live mode): the green **B** / red **S** buttons trade that strike at the Lots stepper size — same pipeline, same rails. BUY is open from 15:15 to 15:29 and only while flat in that strike; SELL only against a page-opened position. Cond-A-banned rows are disabled.
6. Safety rails you cannot bypass from the UI:
   - only strikes of the live session universe are tradable on this page;
   - BUY inside the window-start→exit window, flat-before-long per strike;
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
indicators). Cond A bans any side whose near-ATM premium basket (within 2 steps
of that side's own ATM) crashed ≥50% in the window. The **stronger side wins
the vote** when it is decisive: above +0.30 AND at least +0.20 ahead of the
other side (CE +0.52 vs PE +0.02 is a bullish verdict — the old rule that also
required the loser to be negative is gone). The **15:19/15:20 cross-side rule**
outranks everything: a side's own-ATM red while siblings are green at 15:19,
still green at 15:20 ⇒ buy the **opposite side's own ATM** (22750 CE red ⇒
22800 PE — never the OTM 22750 PE that decays to zero). Without the pattern,
the vote-winner's best projected strike wins (projection = intrinsic at `spot +
avg_gain × 8 × 0.35`). The pick locks at 15:21, BUY MARKET at the 15:21 open,
SELL MARKET at the 15:29 open. Details with exact numbers:
`docs/castrade/LOGIC.md`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "API key not configured" | Generate one at `/apikey`, then reload the page. |
| "No spot reference available" | The broker feed/history for the index is down — check broker login and try again. |
| "No option candles available for the window" | The broker doesn't serve 1-minute history for those option symbols that day. Try a different date/broker or run live mode only. |
| FEED OFFLINE badge | Websocket feed not connected: re-login the broker, verify the feed (websocket proxy port), then Go Live again. |
| "The final pick is not locked yet" on BUY | Wait for the 15:20 bar to close — the Final Trade BUY arms only after the lock. (Quick B/S buttons on strike rows work from 15:15.) |
| "Exit time must be after entry time" | Fix the times in the toolbar — a stale saved exit (e.g. 15:20) with entry 15:21 disarms every order button and is now rejected up front. |
| Live charts frozen (no updates) | Older build pushed updates only via a slow poll — update to this build; the engine now streams `castrade_update` socket events on every tick pass. Also check the FEED badge. |
| "Symbol is not a tradable strike of this live session" | The symbol is outside the session's 14-leg universe — start the session for that underlying/expiry first. |
| Quick BUY disabled on a row | The side is Cond-A-banned, the leg has no data, or you already hold that strike — SELL it first. |
| Funds slider shows an error | The broker funds API failed — refresh, re-login the broker, or size lots manually with the stepper. |
| BUY says "Entry window closed" | Past the exit time; the trade window is over. |
| Charts flat / missing some OTM legs | Those strikes had no ticks/that ladder edge doesn't exist; harmless — the engine skips legs without data. |
| Order rejected | Read the toast — broker margin, freeze limit or product issues surface there; the order pipeline logs the full response under Traffic Logs. |
