"""
CAS Trade Live Engine - tick-by-tick expiry-day feed for the /castrade page.

Reuses the validated replay engine in services/castrade_service.py (OHLC
scoring, Cond A, the 15:19/15:20 cross-side rule, the intrinsic projection)
and runs it on LIVE data:

- On start the session seeds today's 1-minute candles from the history API
  (exactly what the replay consumes) and subscribes the underlying plus every
  leg to the broker feed through the internal WebSocket client.
- Every broker tick is folded into the FORMING 1-minute bar of its symbol -
  open/high/low/close are built tick by tick, nothing waits for the minute
  to close.
- After every ingested tick (throttled) the engine re-runs the WHOLE timeline
  with the forming bars included: verdicts, side votes, Cond A and the
  cross-side pattern all move tick by tick, not bar by bar.
- The moment the decision bar (15:20) closes - the first engine pass at or
  after 15:21 - the pick is LOCKED. That single strike is the trade the
  page's BUY button fires at 15:21 and the SELL button exits at 15:29.
- State is pushed to the browser as ``castrade_update`` socket.io events.
  The initial snapshot after start uses the same payload shape as the replay
  analyze endpoint, so the page renders both identically.

Feed requirements: the broker websocket proxy must be running (it auto-starts
with the app). If no ticks arrive the session still works on the seeded
history and the page shows a FEED OFFLINE badge.
"""

from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime

from services.castrade_service import (
    DEFAULT_ENTRY_TIME,
    DEFAULT_EXIT_TIME,
    DEFAULT_WINDOW_START,
    IST_OFFSET_SECONDS,
    IST_TZ,
    SIDE_CE,
    SIDE_PE,
    SIDE_OFFSETS,
    TV_OF_DEEP_ITM,
    VALID_FO_EXCHANGES,
    WIN_THRESHOLD,
    _bar_at,
    _bar_color,
    _bars_in_minute_window,
    _chart_score,
    _cond_a_state,
    _cross_side_pattern,
    _deepest_itm_ce,
    _entry_bar,
    _exit_price,
    _fetch_candles,
    _fmt_hhmm,
    _minutes,
    _moneyness,
    _normalize_expiry,
    _parse_expiry_date,
    _parse_hhmm,
    _resolve_future_symbol,
    _resolve_universe,
    _scoring_pick,
    _side_votes,
    _to_float,
    _ts_minute,
    _underlying_quote,
    _verdict,
)
from utils.logging import get_logger

logger = get_logger(__name__)

STRATEGY_TAG = "castrade"  # order strategy tag for this page only
MAX_LOTS = 20  # per-click cap, matches the page's lots selector
EVAL_MIN_INTERVAL = 0.5  # seconds between engine passes (tick-throttle)
MAX_BARS_PER_SYMBOL = 450  # full 1m session comfortably fits
EVENTS_CAP = 80
SESSION_TTL_AFTER_EXIT_MIN = 15  # keep the session reviewable after the exit


class CastradeLiveSession:
    """One user's live terminal state. All mutable state is lock-guarded."""

    def __init__(
        self,
        username: str,
        broker: str,
        api_key: str,
        underlying: str,
        fo_exchange: str,
        expiry: str,
        trade_date: str,
        window_start: str,
        entry_time: str,
        exit_time: str,
    ):
        self.id = uuid.uuid4().hex[:12]
        self.lock = threading.RLock()
        self.username = username
        self.broker = broker
        self.api_key = api_key
        self.underlying = underlying
        self.fo_exchange = fo_exchange
        self.expiry = _normalize_expiry(expiry)
        self.trade_date = trade_date

        self.ws_hhmm = _parse_hhmm(window_start, (15, 15))
        self.entry_hhmm = _parse_hhmm(entry_time, (15, 21))
        self.exit_hhmm = _parse_hhmm(exit_time, (15, 29))
        pattern_hhmm = (self.entry_hhmm[0], self.entry_hhmm[1] - 2)
        decision_hhmm = (self.entry_hhmm[0], self.entry_hhmm[1] - 1)
        if pattern_hhmm[1] < 0:
            pattern_hhmm = (pattern_hhmm[0] - 1, pattern_hhmm[1] + 60)
        if decision_hhmm[1] < 0:
            decision_hhmm = (decision_hhmm[0] - 1, decision_hhmm[1] + 60)
        self.pattern_hhmm = pattern_hhmm
        self.decision_hhmm = decision_hhmm

        self.quote_symbol = ""
        self.quote_exchange = ""
        self.atm: float = 0.0
        self.step: float = 0.0
        self.lot_size = 0

        # (strike, side) -> leg dict, replay-helper compatible
        self.legs_by_key: dict[tuple[float, str], dict] = {}
        # "EXCH:SYMBOL" -> {"kind": "leg"|"underlying", "bars": [...], "key": ...}
        self.tick_map: dict[str, dict] = {}
        self.underlying_bars: list[dict] = []
        self.subscribed: list[dict] = []

        self.tick_count = 0
        self.feed_connected = False
        self.last_tick_ts: float | None = None
        self.spot_ref: float | None = None

        self.pick_locked = False
        self.final_pick: dict | None = None
        self.no_trade_reason: str | None = None
        self.orders: list[dict] = []
        self.position_qty = 0

        self.events: list[dict] = []
        self.expired = False
        self.created_at = time.time()
        self.last_eval = 0.0
        self.last_payload: dict | None = None

    # -- small helpers ------------------------------------------------------

    def event(self, text: str, when: tuple[int, int] | None = None) -> None:
        self.events.append(
            {"time": _fmt_hhmm(when) if when else datetime.now(IST_TZ).strftime("%H:%M:%S"), "text": text}
        )
        if len(self.events) > EVENTS_CAP:
            del self.events[: len(self.events) - EVENTS_CAP]

    def ist_now(self) -> datetime:
        return datetime.now(IST_TZ)

    def ist_minute(self) -> int:
        t = self.ist_now()
        return t.hour * 60 + t.minute

    def expired_by_ttl(self) -> bool:
        # Only a TODAY session has a wall-clock TTL; a session started for a
        # past date (tick-replay study) must never be aged out by the clock.
        if self.trade_date != self.ist_now().strftime("%Y-%m-%d"):
            return False
        limit = _minutes(self.exit_hhmm) + SESSION_TTL_AFTER_EXIT_MIN
        return self.ist_minute() > limit

    def window_bars_for(self, leg: dict) -> list[dict]:
        return _bars_in_minute_window(
            leg["day_bars"], _minutes(self.ws_hhmm), _minutes(self.decision_hhmm)
        )


class CastradeLiveManager:
    """Owns the per-user live session and the broker tick callback."""

    def __init__(self):
        self._sessions: dict[str, CastradeLiveSession] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def get(self, username: str) -> CastradeLiveSession | None:
        with self._lock:
            sess = self._sessions.get(username)
        if sess is not None and not sess.expired and sess.expired_by_ttl():
            self.stop(username, reason="session window over")
            sess = self._sessions.get(username)
        return sess

    def start(
        self,
        username: str,
        broker: str,
        api_key: str,
        underlying: str,
        fo_exchange: str,
        expiry: str,
        trade_date: str,
        window_start: str = DEFAULT_WINDOW_START,
        entry_time: str = DEFAULT_ENTRY_TIME,
        exit_time: str = DEFAULT_EXIT_TIME,
    ) -> tuple[dict, int]:
        """Build the session, seed history, subscribe the live feed."""
        underlying = str(underlying or "").strip().upper()
        fo_exchange = str(fo_exchange or "").strip().upper()
        if fo_exchange not in VALID_FO_EXCHANGES:
            return {"status": "error", "message": f"Invalid exchange: {fo_exchange}"}, 400
        if not underlying or not expiry:
            return {"status": "error", "message": "underlying and expiry are required"}, 400

        # Replace any previous session for this user.
        self.stop(username, reason="replaced by a new live session")

        sess = CastradeLiveSession(
            username=username,
            broker=broker,
            api_key=api_key,
            underlying=underlying,
            fo_exchange=fo_exchange,
            expiry=expiry,
            trade_date=trade_date,
            window_start=window_start,
            entry_time=entry_time,
            exit_time=exit_time,
        )

        # --- underlying candles + spot reference (same as replay) ---------
        quote_symbol, quote_exchange = _underlying_quote(underlying, fo_exchange)
        if not quote_symbol and fo_exchange in ("MCX", "CDS"):
            quote_symbol = _resolve_future_symbol(underlying, fo_exchange)
            quote_exchange = fo_exchange
        sess.quote_symbol, sess.quote_exchange = quote_symbol, quote_exchange

        if quote_symbol:
            try:
                sess.underlying_bars = _fetch_candles(
                    quote_symbol, quote_exchange, trade_date, api_key
                )
            except Exception as e:
                logger.warning(f"castrade live: underlying history failed: {e}")

        ws_min = _minutes(sess.ws_hhmm)
        for b in sess.underlying_bars:
            if _ts_minute(b["ts"]) <= ws_min:
                sess.spot_ref = b["c"]
            else:
                break
        if sess.spot_ref is None and sess.underlying_bars:
            sess.spot_ref = sess.underlying_bars[-1]["c"]
        if sess.spot_ref is None:
            try:
                from services.quotes_service import get_quotes

                ok, qresp, _sc = get_quotes(
                    symbol=quote_symbol or underlying,
                    exchange=quote_exchange or fo_exchange,
                    api_key=api_key,
                )
                if ok and isinstance(qresp, dict):
                    sess.spot_ref = _to_float((qresp.get("data") or {}).get("ltp"))
            except Exception as e:
                logger.warning(f"castrade live: quote fallback failed: {e}")

        if not sess.spot_ref or sess.spot_ref <= 0:
            return {
                "status": "error",
                "message": (
                    "No spot reference available for the underlying "
                    f"({quote_symbol or underlying}). Check the broker feed."
                ),
            }, 400

        # --- strike universe (1 ITM + ATM + 6 OTM per side) ---------------
        uni = _resolve_universe(underlying, fo_exchange, sess.expiry, sess.spot_ref)
        if "error" in uni:
            return {"status": "error", "message": uni["error"]}, 400
        sess.atm = uni["atm"]
        sess.step = uni["strike_step"]
        sess.lot_size = uni["lot_size"] or 0

        # --- seed the leg bars from history -------------------------------
        failed = []
        for leg in uni["legs"]:
            key = (leg["strike"], leg["side"])
            if not leg["exists"]:
                sess.legs_by_key[key] = {**leg, "tradable": False, "day_bars": [], "window_bars": []}
                continue
            try:
                bars = _fetch_candles(leg["symbol"], fo_exchange, trade_date, api_key)
            except Exception as e:
                logger.warning(f"castrade live: history failed for {leg['symbol']}: {e}")
                bars = []
            if not bars:
                failed.append(leg["symbol"])
            day_min_start, day_min_end = 9 * 60, 15 * 60 + 30
            day_bars = [b for b in bars if day_min_start <= _ts_minute(b["ts"]) <= day_min_end]
            sess.legs_by_key[key] = {
                **leg,
                "tradable": True,
                "day_bars": day_bars,
                "window_bars": [],
            }

        if not any(
            leg["tradable"] and sess.window_bars_for(leg) for leg in sess.legs_by_key.values()
        ):
            return {
                "status": "error",
                "message": (
                    "No option candles available for the window on "
                    f"{trade_date}. Check the history subscription for option symbols."
                ),
            }, 400

        # --- tick routing table -------------------------------------------
        if quote_symbol:
            sess.tick_map[f"{quote_exchange}:{quote_symbol}"] = {
                "kind": "underlying",
                "bars": sess.underlying_bars,
                "key": None,
            }
        for key, leg in sess.legs_by_key.items():
            if leg["tradable"]:
                sess.tick_map[f"{fo_exchange}:{leg['symbol']}"] = {
                    "kind": "leg",
                    "bars": leg["day_bars"],
                    "key": key,
                }

        with self._lock:
            self._sessions[username] = sess

        sess.event(
            f"Live session started: {underlying} {sess.expiry} {trade_date}, "
            f"ATM {sess.atm:g} step {sess.step:g} lot {sess.lot_size}"
        )
        if failed:
            sess.event(f"No history candles for {len(failed)} leg(s) - live ticks only")

        # --- subscribe the broker feed ------------------------------------
        self._subscribe_feed(sess)

        # First engine pass right away -> full snapshot for the page.
        payload = self._evaluate(sess, full=True)
        return {"status": "success", "data": payload}, 200

    def stop(self, username: str, reason: str = "stopped by user") -> None:
        with self._lock:
            sess = self._sessions.pop(username, None)
        if not sess:
            return
        sess.event(f"Live session ended ({reason})")
        self._teardown_feed(sess)

    # ------------------------------------------------------------------
    # feed plumbing
    # ------------------------------------------------------------------

    def _subscribe_feed(self, sess: CastradeLiveSession) -> None:
        try:
            from services.websocket_service import (
                get_websocket_connection,
                subscribe_to_symbols,
            )

            symbols = []
            if sess.quote_symbol:
                symbols.append({"symbol": sess.quote_symbol, "exchange": sess.quote_exchange})
            for leg in sess.legs_by_key.values():
                if leg["tradable"]:
                    symbols.append({"symbol": leg["symbol"], "exchange": sess.fo_exchange})
            sess.subscribed = symbols

            ok, resp, _code = subscribe_to_symbols(
                username=sess.username, broker=sess.broker, symbols=symbols, mode="LTP"
            )
            if not ok:
                sess.event(f"Feed subscribe failed: {resp.get('message', 'unknown error')}")
                return

            success, client, err = get_websocket_connection(sess.username)
            if not success or client is None:
                sess.event(f"Feed client unavailable: {err or 'not connected'}")
                return
            callback = self._make_callback(sess.username)
            if not client.has_callback("market_data", callback):
                client.register_callback("market_data", callback)
            sess.event(f"Live feed subscribed: {len(symbols)} symbols (LTP ticks)")
        except Exception as e:
            logger.exception(f"castrade live: subscribe failed: {e}")
            sess.event(f"Live feed error: {e}")

    def _teardown_feed(self, sess: CastradeLiveSession) -> None:
        try:
            from services.websocket_service import (
                get_websocket_connection,
                unsubscribe_from_symbols,
            )

            if sess.subscribed:
                unsubscribe_from_symbols(
                    username=sess.username,
                    broker=sess.broker,
                    symbols=sess.subscribed,
                    mode="LTP",
                )
            success, client, _err = get_websocket_connection(sess.username)
            if success and client is not None:
                client.unregister_callback("market_data", self._make_callback(sess.username))
        except Exception as e:
            logger.warning(f"castrade live: teardown issue (ignored): {e}")

    def _make_callback(self, username: str):
        """Stable per-username tick callback (so unregister finds it)."""

        def _on_market_data(data: dict) -> None:
            try:
                self._on_tick(username, data)
            except Exception as e:
                logger.exception(f"castrade live: tick error: {e}")

        # Cache the closure so _make_callback(u) is identity-stable.
        cached = getattr(self, "_callback_cache", None)
        if cached is None:
            cached = {}
            self._callback_cache = cached
        if username not in cached:
            cached[username] = _on_market_data
        return cached[username]

    # ------------------------------------------------------------------
    # ticks -> forming bars
    # ------------------------------------------------------------------

    def _on_tick(self, username: str, data: dict) -> None:
        sess = self._sessions.get(username)
        if sess is None or sess.expired:
            return
        symbol = data.get("symbol")
        exchange = str(data.get("exchange") or "").upper()
        ltp = _to_float(data.get("ltp"))
        if not symbol or ltp is None or ltp <= 0:
            return
        route = sess.tick_map.get(f"{exchange}:{symbol}")
        if route is None:
            return

        ts = _to_float(data.get("timestamp")) or time.time()
        ts = int(ts)
        if ts > 10**12:  # milliseconds -> seconds
            ts //= 1000
        minute = ts - ts % 60  # IST offset is a whole-minute multiple

        with sess.lock:
            bars = route["bars"]
            if bars and bars[-1]["ts"] == minute:
                b = bars[-1]
                if ltp > b["h"]:
                    b["h"] = ltp
                if ltp < b["l"]:
                    b["l"] = ltp
                b["c"] = ltp
            else:
                bars.append({"ts": minute, "o": ltp, "h": ltp, "l": ltp, "c": ltp})
                if len(bars) > MAX_BARS_PER_SYMBOL:
                    bars.pop(0)
            sess.tick_count += 1
            sess.feed_connected = True
            sess.last_tick_ts = time.time()

        self._maybe_evaluate(sess)

    def _maybe_evaluate(self, sess: CastradeLiveSession) -> None:
        now = time.time()
        with sess.lock:
            if now - sess.last_eval < EVAL_MIN_INTERVAL:
                return
            sess.last_eval = now
        try:
            self._evaluate(sess, full=False)
        except Exception as e:
            logger.exception(f"castrade live: evaluate failed: {e}")

    # ------------------------------------------------------------------
    # the engine pass - reuses the validated replay helpers
    # ------------------------------------------------------------------

    def _evaluate(self, sess: CastradeLiveSession, full: bool) -> dict:
        with sess.lock:
            if sess.expired:
                return sess.last_payload or {}

            now_min = sess.ist_minute()
            ws_min = _minutes(sess.ws_hhmm)
            dec_min = _minutes(sess.decision_hhmm)

            for leg in sess.legs_by_key.values():
                leg["window_bars"] = sess.window_bars_for(leg)
            window_map = {k: leg["window_bars"] for k, leg in sess.legs_by_key.items()}

            cond_a = _cond_a_state(sess.legs_by_key, sess.atm, sess.step, window_map)

            # Spot now + window gain: deepest-ITM CE backout (strategy feed),
            # falling back to the underlying feed.
            feed = _deepest_itm_ce(sess.legs_by_key)
            spot_now = sess.spot_ref
            avg_gain = None
            if feed and len(feed["window_bars"]) >= 2:
                closes = [b["c"] for b in feed["window_bars"]]
                spot_now = closes[-1] + feed["strike"] - TV_OF_DEEP_ITM
                n = len(closes) - 1
                avg_gain = (closes[-1] - closes[0]) / n if n else 0.0
            elif sess.underlying_bars:
                cur = [b for b in sess.underlying_bars if _ts_minute(b["ts"]) <= dec_min]
                if cur:
                    spot_now = cur[-1]["c"]
                    start = [b for b in cur if _ts_minute(b["ts"]) >= ws_min]
                    if start and spot_now is not None:
                        avg_gain = cur[-1]["c"] - start[0]["c"]

            votes = _side_votes(window_map, sess.legs_by_key, cond_a)
            pattern = _cross_side_pattern(
                sess.legs_by_key, sess.atm, sess.pattern_hhmm, sess.decision_hhmm, cond_a
            )

            spot_hat = None
            if spot_now is not None and avg_gain is not None:
                spot_hat = spot_now + avg_gain * 8 * 0.35

            # Current pick: pattern outranks scoring - same as the replay.
            pick_leg = None
            pick_source = None
            pick_reason = None
            projected_pct = None
            fresh_flip = False
            if pattern["found"]:
                pick_leg = sess.legs_by_key.get((pattern["mirror_strike"], pattern["mirror_side"]))
                pick_source = "pattern"
                pick_reason = pattern["reason"]
            else:
                sc_leg, sc_why = _scoring_pick(
                    sess.legs_by_key, votes["winning"], sess.decision_hhmm, spot_now, avg_gain
                )
                if sc_leg is not None:
                    pick_leg = sc_leg["leg"]
                    pick_source = "scoring"
                    pick_reason = sc_why
                    projected_pct = sc_leg["projected_pct"]
                    fresh_flip = sc_leg["fresh_flip"]
                elif now_min < _minutes(sess.entry_hhmm):
                    pick_reason = sc_why

            # Lock the final pick on the first pass at/after the entry time:
            # the decision bar has closed and the 15:21 BUY is live.
            if not sess.pick_locked and now_min >= _minutes(sess.entry_hhmm):
                if pick_leg is not None:
                    sess.final_pick = {
                        "side": pick_leg["side"],
                        "strike": pick_leg["strike"],
                        "symbol": pick_leg["symbol"],
                        "exchange": sess.fo_exchange,
                        "source": pick_source,
                        "reason": pick_reason,
                        "entry_time": _fmt_hhmm(sess.entry_hhmm),
                        "exit_time": _fmt_hhmm(sess.exit_hhmm),
                        "lot_size": sess.lot_size,
                        "projected_pct": round(projected_pct, 2) if projected_pct is not None else None,
                    }
                    sess.pick_locked = True
                    sess.event(
                        f"FINAL PICK LOCKED: {pick_leg['symbol']} "
                        f"({pick_source}) - BUY {_fmt_hhmm(sess.entry_hhmm)}, "
                        f"SELL {_fmt_hhmm(sess.exit_hhmm)}",
                        sess.decision_hhmm,
                    )
                elif now_min >= _minutes(sess.exit_hhmm):
                    sess.pick_locked = True
                    sess.no_trade_reason = pick_reason or "No qualified entry for the day"
                    sess.event(f"NO TRADE - {sess.no_trade_reason}", sess.exit_hhmm)

            payload = self._build_payload(
                sess,
                full=full,
                cond_a=cond_a,
                votes=votes,
                pattern=pattern,
                spot_now=spot_now,
                spot_hat=spot_hat,
                pick_leg=pick_leg,
                pick_source=pick_source,
                pick_reason=pick_reason,
                projected_pct=projected_pct,
                fresh_flip=fresh_flip,
            )
            sess.last_payload = payload
            return payload

    # ------------------------------------------------------------------
    # payload builders
    # ------------------------------------------------------------------

    def _leg_meta(self, sess: CastradeLiveSession, leg: dict, cond_a: dict, spot_hat) -> dict:
        window = leg["window_bars"]
        sc = (
            _chart_score(window)
            if len(window) >= 2
            else {"labels": [], "norm": 0.0, "flip": False}
        )
        b19 = _bar_at(window, sess.pattern_hhmm)
        b20 = _bar_at(window, sess.decision_hhmm)

        now_p = window[-1]["c"] if window else None
        projected = None
        if spot_hat is not None and now_p:
            intrinsic = (
                max(spot_hat - leg["strike"], 0.0)
                if leg["side"] == SIDE_CE
                else max(leg["strike"] - spot_hat, 0.0)
            )
            proj = intrinsic + 0.5 if intrinsic > 0 else 0.05
            projected = (proj - now_p) / now_p * 100.0 if now_p > 0 else 0.0

        # Live actuals: entry bar open once 15:21 has printed, exit at 15:29.
        actual = None
        if leg["tradable"]:
            eb = _entry_bar(leg["day_bars"], sess.entry_hhmm)
            if eb:
                entry_p = eb["o"]
                exit_p = _exit_price(leg["day_bars"], sess.exit_hhmm)
                if entry_p and entry_p > 0:
                    actual = {"entry_price": round(entry_p, 2)}
                    if exit_p is not None:
                        pts = exit_p - entry_p
                        actual.update(
                            {
                                "exit_price": round(exit_p, 2),
                                "pnl_per_unit": round(pts, 2),
                                "pct": round(pts / entry_p * 100.0, 2),
                            }
                        )

        moneyness, otm_steps = _moneyness(leg["side"], leg["offset"])
        return {
            "offset": leg["offset"],
            "moneyness": moneyness,
            "otm_steps": otm_steps,
            "strike": leg["strike"],
            "side": leg["side"],
            "symbol": leg["symbol"],
            "exists": leg["exists"],
            "tradable": leg["tradable"],
            "score": round(sc["norm"], 3),
            "verdict": _verdict(sc["norm"]),
            "flip": sc["flip"],
            "blocked": bool(cond_a[leg["side"]]["banned"]),
            "bar_pattern": {**b19, "color": _bar_color(b19)} if b19 else None,
            "bar_decision": {**b20, "color": _bar_color(b20)} if b20 else None,
            "premium_at_decision": now_p,
            "premium_live": now_p,
            "projected_pct": round(projected, 2) if projected is not None else None,
            "actual": actual,
        }

    def _final_trade_view(self, sess: CastradeLiveSession) -> dict | None:
        if not sess.final_pick:
            return None
        leg = sess.legs_by_key.get((sess.final_pick["strike"], sess.final_pick["side"]))
        outcome = None
        if leg and leg["tradable"]:
            eb = _entry_bar(leg["day_bars"], sess.entry_hhmm)
            if eb:
                exit_p = _exit_price(leg["day_bars"], sess.exit_hhmm)
                outcome = {"entry_price": eb["o"], "exit_price": exit_p}
        entry_p = outcome["entry_price"] if outcome else None
        exit_p = outcome.get("exit_price") if outcome else None
        return {
            **sess.final_pick,
            "entry_price": round(entry_p, 2) if entry_p else None,
            "exit_price": round(exit_p, 2) if exit_p else None,
            "pnl_per_unit": (
                round(exit_p - entry_p, 2) if (entry_p and exit_p is not None) else None
            ),
            "pct": (
                round((exit_p - entry_p) / entry_p * 100.0, 2)
                if (entry_p and exit_p is not None)
                else sess.final_pick.get("projected_pct")
            ),
            "pending": outcome is None,
        }

    def _build_payload(
        self,
        sess: CastradeLiveSession,
        full: bool,
        cond_a: dict,
        votes: dict,
        pattern: dict,
        spot_now,
        spot_hat,
        pick_leg,
        pick_source,
        pick_reason,
        projected_pct,
        fresh_flip,
    ) -> dict:
        now_min = sess.ist_minute()
        phase = "pre" if now_min < _minutes(sess.ws_hhmm) else (
            "window" if now_min < _minutes(sess.entry_hhmm) else (
                "position" if now_min < _minutes(sess.exit_hhmm) else "done"
            )
        )
        expiry_dt = _parse_expiry_date(sess.expiry)
        trade_date_dt = None
        try:
            trade_date_dt = datetime.strptime(sess.trade_date, "%Y-%m-%d")
        except ValueError:
            pass
        is_expiry_day = bool(
            expiry_dt and trade_date_dt and expiry_dt.date() == trade_date_dt.date()
        )

        base = {
            "session_id": sess.id,
            "mode": "live",
            "live": True,
            "underlying": sess.underlying,
            "fo_exchange": sess.fo_exchange,
            "quote_symbol": sess.quote_symbol,
            "quote_exchange": sess.quote_exchange,
            "expiry": sess.expiry,
            "trade_date": sess.trade_date,
            "is_expiry_day": is_expiry_day,
            "atm": sess.atm,
            "strike_step": sess.step,
            "lot_size": sess.lot_size,
            "window": {
                "start": _fmt_hhmm(sess.ws_hhmm),
                "pattern_bar": _fmt_hhmm(sess.pattern_hhmm),
                "decision_bar": _fmt_hhmm(sess.decision_hhmm),
                "entry": _fmt_hhmm(sess.entry_hhmm),
                "exit": _fmt_hhmm(sess.exit_hhmm),
            },
            "phase": phase,
            "spot": {
                "at_window_start": round(sess.spot_ref, 2) if sess.spot_ref else None,
                "at_decision": round(spot_now, 2) if spot_now else None,
                "projected_exit": round(spot_hat, 2) if spot_hat else None,
            },
            "votes": {
                "ce": round(votes["ce"], 3),
                "pe": round(votes["pe"], 3),
                "winning": votes["winning"],
                "threshold": WIN_THRESHOLD,
            },
            "cond_a": {
                side: {
                    "base": round(cond_a[side]["base"], 2) if cond_a[side]["base"] else None,
                    "low": (
                        round(cond_a[side]["low"], 2)
                        if cond_a[side]["low"] is not None
                        else None
                    ),
                    "banned": cond_a[side]["banned"],
                    "drop_pct": round(cond_a[side]["drop_pct"], 1),
                }
                for side in (SIDE_CE, SIDE_PE)
            },
            "pattern": {
                "found": pattern["found"],
                "reason": pattern.get("reason"),
                "red_side": pattern.get("red_side"),
                "mirror_strike": pattern.get("mirror_strike"),
                "mirror_side": pattern.get("mirror_side"),
                "greens": pattern.get("greens"),
                "still_green": pattern.get("still_green"),
            },
            "final_trade": self._final_trade_view(sess),
            "no_trade_reason": sess.no_trade_reason,
            "pick_locked": sess.pick_locked,
            "preview_pick": (
                {
                    "side": pick_leg["side"],
                    "strike": pick_leg["strike"],
                    "symbol": pick_leg["symbol"],
                    "source": pick_source,
                    "reason": pick_reason,
                }
                if (pick_leg is not None and not sess.pick_locked)
                else None
            ),
            "preview_source": pick_source,
            "preview_reason": pick_reason,
            "events": list(sess.events[-14:]),
            "feed": {
                "connected": sess.feed_connected,
                "tick_count": sess.tick_count,
                "last_tick_age_sec": (
                    round(time.time() - sess.last_tick_ts, 1) if sess.last_tick_ts else None
                ),
                "symbols": len(sess.subscribed),
            },
            "orders": list(sess.orders[-10:]),
            "position_qty": sess.position_qty,
            "analyzer_mode": False,
            "server_time": datetime.now(IST_TZ).strftime("%H:%M:%S"),
        }

        if full:
            # Full snapshot: every leg with its complete day candles so the
            # page can (re)build all charts. Same shape as the replay payload.
            legs_out = []
            for side in (SIDE_CE, SIDE_PE):
                for off in SIDE_OFFSETS[side]:
                    matches = [
                        leg
                        for leg in sess.legs_by_key.values()
                        if leg["offset"] == off and leg["side"] == side
                    ]
                    if not matches:
                        continue
                    leg = matches[0]
                    meta = self._leg_meta(sess, leg, cond_a, spot_hat)
                    meta["candles"] = [
                        {
                            "time": ((b["ts"] + IST_OFFSET_SECONDS) // 60) * 60,
                            "open": b["o"],
                            "high": b["h"],
                            "low": b["l"],
                            "close": b["c"],
                        }
                        for b in leg["day_bars"]
                    ]
                    legs_out.append(meta)
            base["legs"] = legs_out
            base["underlying_candles"] = [
                {
                    "time": ((b["ts"] + IST_OFFSET_SECONDS) // 60) * 60,
                    "open": b["o"],
                    "high": b["h"],
                    "low": b["l"],
                    "close": b["c"],
                }
                for b in sess.underlying_bars
                if 9 * 60 <= _ts_minute(b["ts"]) <= 15 * 60 + 30
            ]
            base["analyzer_mode"] = self._analyzer_mode()
        else:
            # Delta: leg metas + only the tail candle of each leg.
            legs_out = []
            for leg in sess.legs_by_key.values():
                if not leg["tradable"]:
                    continue
                meta = self._leg_meta(sess, leg, cond_a, spot_hat)
                if leg["day_bars"]:
                    b = leg["day_bars"][-1]
                    meta["last_candle"] = {
                        "time": ((b["ts"] + IST_OFFSET_SECONDS) // 60) * 60,
                        "open": b["o"],
                        "high": b["h"],
                        "low": b["l"],
                        "close": b["c"],
                    }
                legs_out.append(meta)
            base["legs"] = legs_out
            base["type"] = "delta"
        return base

    def _analyzer_mode(self) -> bool:
        try:
            from database.settings_db import get_analyze_mode

            return bool(get_analyze_mode())
        except Exception:
            return False

    # ------------------------------------------------------------------
    # order bookkeeping (orders themselves are placed by the blueprint)
    # ------------------------------------------------------------------

    def can_trade(self, sess: CastradeLiveSession, action: str, symbol: str) -> tuple[bool, str]:
        if not sess.pick_locked:
            return False, "The final pick is not locked yet (wait for the decision bar to close)"
        if not sess.final_pick:
            return False, "No qualified trade today - the engine said NO TRADE"
        if symbol != sess.final_pick["symbol"]:
            return (
                False,
                "This page only trades the final pick "
                f"({sess.final_pick['symbol']}); {symbol} is not it",
            )
        now_min = sess.ist_minute()
        entry_min = _minutes(sess.entry_hhmm)
        exit_min = _minutes(sess.exit_hhmm)
        if action == "BUY":
            if now_min < entry_min:
                return False, f"Entry window not open yet (BUY at {sess.final_pick['entry_time']})"
            if now_min > exit_min:
                return False, "Entry window closed (past the exit time)"
            if sess.position_qty > 0:
                return False, "Position already open - use SELL to exit first"
            return True, ""
        if action == "SELL":
            if sess.position_qty <= 0:
                return False, "No open position from this page to sell"
            return True, ""
        return False, f"Invalid action: {action}"

    def record_order(self, username: str, record: dict) -> None:
        sess = self._sessions.get(username)
        if not sess:
            return
        with sess.lock:
            sess.orders.append(record)
            if len(sess.orders) > 50:
                del sess.orders[: len(sess.orders) - 50]
            if record.get("status") == "success":
                signed = record.get("quantity", 0) * (1 if record.get("action") == "BUY" else -1)
                sess.position_qty = max(0, sess.position_qty + signed)

    def state(self, username: str, full: bool = False) -> dict | None:
        sess = self._sessions.get(username)
        if not sess:
            return None
        if full or sess.last_payload is None:
            return self._evaluate(sess, full=True)
        return self._evaluate(sess, full=False)


# Module-level singleton.
_manager = CastradeLiveManager()


def get_castrade_live_manager() -> CastradeLiveManager:
    return _manager
