# CAS Prediction — Point-Wise Logic (as concluded)

**Goal:** on the expiry day, end with exactly ONE option strike — BUY at the 15:21 bar open, SELL at the 15:29 bar open. No indicators, no volume, no OI, no IV. Only 1-minute candle-vs-candle OHLC.

This document is the single source of truth for what `/castrade` implements
(`services/castrade_service.py` for the replay and `services/castrade_live.py`
for the tick-by-tick live engine — same functions, same numbers).

---

## 1. The strike universe (what is watched)

1. At the window open (15:15) the spot is captured once and frozen - this is the **baseline spot**.
2. **ONE shared ladder of SEVEN strikes**: 3 strikes BELOW + the baseline ATM + 3 strikes ABOVE the 15:15 baseline spot (the ladder is centered on the CE ATM = the strike at/below the spot; the PE ATM = the strike at/above the spot is the +1 rung when the spot sits between two strikes).
3. Every strike carries BOTH a CE and a PE leg - **7 strikes x 2 sides = 14 legs**.
4. Moneyness labels stay **per-side** relative to that side's own ATM (the one-strike-difference convention):
   - **CE ATM = the listed strike AT/BELOW the spot** (floor strike) - every strike ABOVE it is OTM for CE, every strike BELOW it is ITM.
   - **PE ATM = the listed strike AT/ABOVE the spot** (ceil strike) - every strike BELOW it is OTM for PE, every strike ABOVE it is ITM.
   - Example (spot 22760.75, step 50): ladder 22600..22900, **CE ATM 22750, PE ATM 22800** - one spot, one ladder, both ATMs visible. The old single-shared-ATM build put PE's labels one wall too low; the per-side labeling fixes that while the display stays one symmetric ladder.
5. Strike step comes from the master contract (NIFTY 50, BANKNIFTY 100, …) — nothing is hard-coded; ladder rungs clamp to the nearest listed strike at the ladder edges.
6. Leg symbols are constructed in OpenAlgo format and verified against the master contract; lot size comes from the contract too.
7. Works for ANY index or F&O underlying (NFO/BFO/MCX/CDS) — symbol, step and lot are resolved, never assumed.

## 2. The candle transition score (per leg, per bar pair)

For each 1-minute bar versus the previous bar of the SAME leg:

| # | Rule | Points |
|---|------|--------|
| 1 | Higher high AND higher low → `UP` | +2 |
| 2 | Lower high AND lower low → `DOWN` | −2 |
| 3 | High ≤ prev high AND low ≥ prev low → `INSIDE` | 0 |
| 4 | Everything else → `OUTSIDE` | ±2 by close direction |
| 5 | Close confirmation (close > prev close) | +1 / −1 |
| 6 | Candle colour (close vs open) | +1 / −1 |
| 7 | Close above prev high (+1) or below prev low (−1) | ±1 |

## 3. The window score (normalized)

1. The scoring window is 15:15 → 15:20 (five bars, `window_start` → `decision_bar`).
2. Every transition gets a **recency weight** = its bar index (1..4), so the latest candles matter most.
3. Raw sum ÷ (5 × Σweights) → normalized score in **−1 … +1**.
4. Verdict bands: ≥ +0.50 `STRONG UP`, ≥ +0.20 `UP`, ≤ −0.50 `STRONG DOWN`, ≤ −0.20 `DOWN`, else `MIXED`.
5. **FRESH FLIP** = two consecutive `UP` transitions after a non-UP base — the "catch the turn" flag.

## 4. Cond A — the crash filter (side ban)

1. Per side, the near-ATM basket = the average premium of strikes within 2 × step of **that side's own ATM** (its ITM, ATM and first OTM legs).
2. Base = the basket's first window reading. If the basket's LOW drops **50% or more** below the base, that side is **banned for the day**.
3. A banned side can never win the vote, and a pattern whose red or mirror side is banned is discarded (`REQUIRE_BOTH_SIDES_CLEAN`).

## 5. The side vote

1. Sum the normalized scores of every tradable leg on each side.
2. The **STRONGER side wins** when it is decisive: its total must be above **+0.30** (`WIN_THRESHOLD`) AND it must beat the other side by at least **+0.20** (`VOTE_MARGIN`), and it must not be Cond-A-banned.
3. This replaces the old double-negative rule (one side above +0.30 AND the other below −0.30), which wrongly answered NO TRADE for reads like CE +0.52 / PE +0.02 — a calm bullish verdict where the losing side is merely flat. The margin guard keeps true conflicts out: CE +0.52 vs PE +0.40 (margin 0.12) is still no trade.
4. The winning side is where the BUY candidate comes from; a tie (equal totals) can never win.

## 6. The 15:19 / 15:20 cross-side confirmation (the pattern — highest priority)

1. At the **15:19 close** (pattern bar): the near-ATM strike of one side — **that side's own ATM** — is **RED** while at least one other strike on that SAME side is **GREEN**.
2. At the **15:20 close** (decision bar): that side must still be green — at least half the greens held.
3. If both hold → **BUY the MIRROR strike = the OPPOSITE side's OWN ATM**:
   - near-ATM **CE** red (e.g. 22750 CE, CE's ATM) + other CEs green ⇒ buy **PE's ATM** (22800 PE).
   - near-ATM **PE** red (22800 PE, PE's ATM) + other PEs green ⇒ buy **CE's ATM** (22750 CE).
   - The mirror is never a same-number strike on the wrong rung: with the per-side ATMs one step apart, opposite-ATM-to-opposite-ATM is the same "behaves like spot" rung on the other side, and it can never recommend the OTM put/call one wall below/above that decays to zero.
   - Fallback if the opposite ATM leg is missing/untradable: the opposite side's first OTM, then its ITM.
4. The pattern pick **outranks** the scoring pick.
5. Either side being Cond-A-banned kills the pattern.

## 7. The scoring fallback (when the pattern does not print)

1. Take the vote-winning side (§5). If no side won, or a side is banned — no trade.
2. Rank the side's strikes by **projected % return**:
   - Spot now = deepest-ITM CE close + strike − 2.0 (time-value backout; index feed fallback).
   - Window gain = (last − first) deepest-ITM CE close per bar.
   - `spot_hat = spot_now + avg_gain × 8 bars × 0.35 decay` (15:21 → 15:29).
   - Projected premium = intrinsic(spot_hat) + 0.5 (or 0.05 if OTM); `%return = (proj − now)/now × 100`.
3. Eligibility: verdict UP/STRONG UP, projected > 0.05, %return > 0, premium ≥ 1.00 (`MIN_PREMIUM`).
4. Best % wins — with FRESH FLIP noted.

## 8. The lock — one strike, one trade

1. The pick is **locked the moment the 15:20 bar closes** (first engine pass at/after 15:21). Before that the page shows a live, tick-by-tick **preview** of the forming pick.
2. The locked pick is final for the day: `final_trade = {side, strike, symbol, source: pattern|scoring}`.
3. Entry = **BUY MARKET at the 15:21 bar open**. Exit = **SELL MARKET at the 15:29 bar open** (8 bars ≈ decay horizon). No stops, no re-entry: the strategy is the 8-minute window, nothing else.
4. If no pattern and no scoring pick qualified: **NO TRADE** — capital preserved; that is also an outcome.

## 9. Tick-by-tick execution (live mode)

1. On `Go Live` the session seeds today's 1-minute candles from history and subscribes the underlying + all 14 legs (LTP ticks) on the broker feed.
2. Every tick folds into the **forming bar** (o/h/l/c built tick by tick) — nothing waits for the minute to close.
3. The whole engine (§2–§7) re-runs on every tick pass (0.5 s throttle), so verdicts, votes, Cond A and the pattern preview move **tick by tick**.
4. Every engine pass is **pushed to the browser** as a `castrade_update` socket.io event (`emit_from_any_thread`, safe from the feed callback thread); a 5 s REST poll is only a fallback. Before this push existed the page depended on the slow poll and looked frozen.
5. The window/entry/exit times are editable in the toolbar; an exit time at or before the entry time is rejected up front (a stale persisted exit of 15:20 used to silently disarm every order button).

## 10. Order safety rails

1. Every **tradable strike of the live session universe** (the 14 legs) can be traded from the page — the locked final pick via the Final Trade panel's BUY/SELL, and ANY strike row via its quick **B / S** buttons. Symbols outside the session universe are rejected server-side.
2. BUY is open from the window start (15:15) until the exit time (15:29) and only while this page is flat in that strike; SELL only against a position opened from this page (per-symbol tracking, so quick trades on different strikes stay independent).
3. MARKET orders, whole lots, 1–20 lots per click, qty = lots × contract lot size; strategy tag `castrade` keeps broker-side bookkeeping separable.
4. Analyzer/sandbox mode is honored end-to-end: with it on, "real" buttons route to the sandbox instead of the broker.
5. Cond A ban (a banned side's rows are disabled), MIN_PREMIUM and the session-universe check are server-side; the buttons cannot override them.

## 11. Quick trade sizing — the funds-% slider

1. Directly below the Final Trade panel sits the **Funds %** slider (1–100%, default 25%). It reads the broker's available funds on session start (refresh button re-reads).
2. It shows the deployable amount (`available × %`) and the whole-lot equivalent at the final pick's live premium: `lots = floor(deployable / (premium × lot_size))`.
3. **Apply** syncs the Final Trade panel's Lots stepper to that size (capped 1–20). The quick B/S buttons on the strike rows use the same Lots stepper value.
4. Nothing is ever ordered by the slider itself — it only sizes the next manual order.

---

### Final answer the engine must produce

> At 15:21 exactly ONE strike: **pattern** (15:19/15:20 cross-side red/green, mirror side) if it printed, else the vote-winner's best-projected strike — BUY at the 15:21 open, SELL at the 15:29 open, or explicitly NO TRADE.
