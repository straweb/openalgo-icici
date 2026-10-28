"""
CAS Trade Service - expiry-day closing-window CAS prediction, analysis only.

Powers the /castrade page. It ports the validated cas_prediction strategy
logic (phase-1 OHLC strike picker + the 15:19/15:20 cross-side red/green
confirmation + Cond A crash filter + intrinsic projection) into a service:
it fetches 1-minute candles for the underlying and the strike universe (per
side: ONE ITM strike + ATM + SIX OTM strikes), replays the strategy timeline
on them and returns the charts, per-strike analysis and the single final
winning trade (buy 15:21, sell 15:29). services/castrade_live.py reuses this
module's engine functions to run the same timeline tick-by-tick on live feeds.

HARD RULES (identical to the strategy):
- No indicators, no volume, no OI, no IV. Only candle-vs-candle 1m OHLC.
- UP/DOWN/INSIDE/OUTSIDE transitions + close confirmations, recency-weighted.
- Side vote: one side > +WIN_THRESHOLD while the other < -WIN_THRESHOLD.
- Cross-side rule: at the 15:19 close the near-ATM strike on one side is RED
  while at least one other strike on that same side is GREEN, and that side
  is still green at the 15:20 close -> buy the MIRROR strike on the opposite
  side at 15:21, exit 15:29. This pick outranks the scoring pick.
- Cond A: if a side's near-ATM premium basket drops CRASH_DROP_PCT below its
  first window reading, that side is banned for the day.
- Spot backout from the deepest-ITM CE (time value ~ TV_OF_DEEP_ITM) when the
  index feed is missing; projection adds avg window gain x EXIT_BARS x DECAY.

Works for ANY index or F&O underlying: symbol, exchange, strike step and lot
size are all resolved from the master contract, nothing is hard-coded.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from database.settings_db import get_analyze_mode
from services.expiry_service import get_expiry_dates
from services.history_service import get_history
from services.option_symbol_service import (
    construct_option_symbol,
    get_available_strikes,
)
from utils.logging import get_logger
from utils.thread_safe_cache import LockedTTLCache

logger = get_logger(__name__)

# Fixed IST offset: broker timestamps are absolute epoch seconds and the
# strategy timeline lives on IST clock times, so every timestamp conversion
# below is explicit - the engine must behave identically on a UTC server and
# on an IST server.
IST_TZ = timezone(timedelta(hours=5, minutes=30))

# ---------------------------------------------------------------------------
# Constants (the validated strategy values - do not change lightly)
# ---------------------------------------------------------------------------

SIDE_CE = "CE"
SIDE_PE = "PE"

# Strike matrix: BOTH sides show exactly ONE ITM strike, the ATM strike and
# SIX OTM strikes - built around each side's OWN ATM (per-side ATM):
#   CE ATM = the listed strike AT/BELOW the spot (floor strike). It carries the
#     small intrinsic and behaves like the spot for calls; every strike ABOVE
#     it is OTM for CE, every strike BELOW it is ITM.
#   PE ATM = the listed strike AT/ABOVE the spot (ceil strike). Every strike
#     BELOW it is OTM for PE, every strike ABOVE it is ITM.
# Example (spot 22760.75, step 50): CE ATM 22750, PE ATM 22800 - one strike
# apart. CE legs 22700(ITM) 22750(ATM) 22800..23100(OTM); PE legs
# 22850(ITM) 22800(ATM) 22750..22500(OTM). Offsets are strike-ladder steps
# relative to the SIDE's ATM, signed toward higher strikes on both sides.
CE_OFFSETS = [-1, 0, 1, 2, 3, 4, 5, 6]  # 1 ITM, ATM, 6 OTM
PE_OFFSETS = [1, 0, -1, -2, -3, -4, -5, -6]  # 1 ITM, ATM, 6 OTM (mirrored)
SIDE_OFFSETS = {SIDE_CE: CE_OFFSETS, SIDE_PE: PE_OFFSETS}

WIN_THRESHOLD = 0.30  # side vote threshold on summed per-leg norms
TV_OF_DEEP_ITM = 2.0  # assumed time value of the deepest ITM CE (spot backout)
DECAY = 0.35  # projection decay over the remaining bars
EXIT_BARS = 8  # 15:21 read -> 15:29 exit
MIN_TICK = 0.05
MIN_PREMIUM = 1.00  # never pick a leg priced below this
CRASH_DROP_PCT = 50.0  # Cond A: basket drop (percent) that bans a side
REQUIRE_BOTH_SIDES_CLEAN = True  # pattern entry needs no Cond A on either side

DEFAULT_WINDOW_START = "15:15"  # first scoring bar of the window
DEFAULT_ENTRY_TIME = "15:21"  # BUY fires at the open of this bar
DEFAULT_EXIT_TIME = "15:29"  # SELL fires at the open of this bar

# Timeline defaults derived from the entry time: the cross-side pattern reads
# the bar two minutes before entry (15:19) and confirms on the bar one minute
# before entry (15:20); the scoring window ends at that same decision bar.

IST_OFFSET_SECONDS = 19800  # baked into bar times so lightweight-charts shows IST

# Fallback strike steps when the master contract cannot answer (never used
# before the DB inference below - kept for offline demos only).
FALLBACK_STRIKE_STEPS = {
    "NIFTY": 50,
    "BANKNIFTY": 100,
    "FINNIFTY": 50,
    "MIDCPNIFTY": 25,
    "SENSEX": 100,
}

# Index underlyings per segment: (quote symbol set, index exchange)
NSE_INDEX_UNDERLYINGS = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "INDIAVIX"}
BSE_INDEX_UNDERLYINGS = {"SENSEX", "BANKEX", "SENSEX50"}

VALID_FO_EXCHANGES = {"NFO", "BFO", "MCX", "CDS"}

_HIST_CACHE = LockedTTLCache(maxsize=512, ttl=60)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _parse_hhmm(value: str, default: tuple[int, int]) -> tuple[int, int]:
    """Parse 'HH:MM' into (hour, minute), falling back to the default."""
    try:
        parts = str(value or "").strip().split(":")
        h, m = int(parts[0]), int(parts[1])
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except (TypeError, ValueError, IndexError):
        pass
    return default


def _minutes(hhmm: tuple[int, int]) -> int:
    return hhmm[0] * 60 + hhmm[1]


def _fmt_hhmm(hhmm: tuple[int, int]) -> str:
    return f"{hhmm[0]:02d}:{hhmm[1]:02d}"


def _parse_expiry_date(expiry: str) -> datetime | None:
    """Parse DDMMMYY / DD-MMM-YY / YYYY-MM-DD expiry into a date."""
    s = str(expiry or "").strip().upper()
    for fmt in ("%d%b%y", "%d-%b-%y", "%d-%b-%Y", "%d%b%Y", "%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _normalize_expiry(expiry: str) -> str:
    """Normalize an expiry string to DDMMMYY uppercase ('10-JUL-25' -> '10JUL25')."""
    return str(expiry or "").replace("-", "").replace(" ", "").upper()


def _to_float(v) -> float | None:
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def _underlying_quote(underlying: str, fo_exchange: str) -> tuple[str, str]:
    """Return (quote symbol, quote exchange) for the underlying.

    Mirrors the scalping terminal's resolution: indices quote on the index
    segment, stocks on the cash segment, MCX/CDS on the near-month future.
    """
    if fo_exchange == "NFO":
        if underlying in NSE_INDEX_UNDERLYINGS:
            return underlying, "NSE_INDEX"
        return underlying, "NSE"
    if fo_exchange == "BFO":
        if underlying in BSE_INDEX_UNDERLYINGS:
            return underlying, "BSE_INDEX"
        return underlying, "BSE"
    # MCX / CDS: no spot instrument - the near-month future is the reference.
    return "", ""


def _resolve_future_symbol(underlying: str, exchange: str) -> str | None:
    """Near-month future symbol for exchanges without a spot (MCX/CDS)."""
    try:
        from database.symbol import SymToken
        from database.symbol import db_session as symbol_session

        rows = (
            symbol_session.query(SymToken)
            .filter(
                SymToken.exchange == exchange,
                SymToken.name == underlying,
                SymToken.instrumenttype == "FUT",
            )
            .all()
        )

        def _exp_key(r):
            d = _parse_expiry_date(r.expiry or "")
            return d or datetime.max

        rows = sorted(rows, key=_exp_key)
        return rows[0].symbol if rows else None
    except Exception as e:
        logger.exception(f"castrade: future resolution failed for {underlying}: {e}")
        return None


# ---------------------------------------------------------------------------
# Candle plumbing
# ---------------------------------------------------------------------------


def _normalize_rows(rows: list) -> list[dict]:
    """Normalize a broker history payload into {ts, o, h, l, c} dicts.

    Timestamps are normalized to bar START in epoch seconds: brokers that
    stamp the bar END (first bar 09:16 instead of 09:15) are shifted once,
    detected on the first two bars, exactly like the strategy runner.
    """
    bars: list[dict] = []
    for r in rows or []:
        try:
            if isinstance(r, (list, tuple)):
                ts, op, hp, lp, cp = r[0], r[1], r[2], r[3], r[4]
            else:
                ts = r.get("timestamp", r.get("time", r.get("ts")))
                op = r.get("open")
                hp = r.get("high")
                lp = r.get("low")
                cp = r.get("close")
            if ts is None:
                continue
            vals = [_to_float(x) for x in (op, hp, lp, cp)]
            if any(v is None for v in vals):
                continue
            ts = int(float(ts))
            if ts > 10**12:  # milliseconds -> seconds
                ts //= 1000
            op, hp, lp, cp = vals
            if hp < max(op, cp) or lp > min(op, cp) or lp > hp:
                hp = max(op, hp, lp, cp)
                lp = min(op, hp, lp, cp)
            bars.append({"ts": ts, "o": op, "h": hp, "l": lp, "c": cp})
        except (TypeError, ValueError, KeyError, IndexError):
            continue
    bars.sort(key=lambda b: b["ts"])

    # End-stamped bars: second bar of the day lands on 09:17 with the first
    # on 09:16 -> every broker bar is the END of its minute; shift to START.
    if len(bars) >= 2:
        t0 = datetime.fromtimestamp(bars[0]["ts"], tz=IST_TZ)
        t1 = datetime.fromtimestamp(bars[1]["ts"], tz=IST_TZ)
        if (t0.hour, t0.minute) == (9, 16) and (t1.hour, t1.minute) == (9, 17):
            for b in bars:
                b["ts"] -= 60
    return bars


def _fetch_candles(symbol: str, exchange: str, trade_date: str, api_key: str) -> list[dict]:
    """1-minute candles for one symbol on one day, TTL-cached per symbol+date."""
    key = (symbol.upper(), exchange.upper(), trade_date, "1m")

    def _load():
        success, response, _status = get_history(
            symbol=symbol,
            exchange=exchange,
            interval="1m",
            start_date=trade_date,
            end_date=trade_date,
            api_key=api_key,
        )
        if not success or not isinstance(response, dict):
            return []
        return _normalize_rows(response.get("data") or [])

    return _HIST_CACHE.get_or_load(key, _load, should_cache=bool)


# ---------------------------------------------------------------------------
# THE OHLC LOGIC - identical to the validated phase-1 tool / strategy runner
# ---------------------------------------------------------------------------


def _compare(prev: dict, cur: dict) -> tuple[str, int]:
    """Candle-vs-candle transition: label + raw points."""
    if cur["h"] > prev["h"] and cur["l"] > prev["l"]:
        label, pts = "UP", 2
    elif cur["h"] < prev["h"] and cur["l"] < prev["l"]:
        label, pts = "DOWN", -2
    elif cur["h"] <= prev["h"] and cur["l"] >= prev["l"]:
        label, pts = "INSIDE", 0
    else:
        label = "OUTSIDE"
        pts = 2 if cur["c"] > prev["c"] else -2
    pts += 1 if cur["c"] > prev["c"] else (-1 if cur["c"] < prev["c"] else 0)
    pts += 1 if cur["c"] > cur["o"] else (-1 if cur["c"] < cur["o"] else 0)
    if cur["c"] >= prev["h"]:
        pts += 1
    elif cur["c"] <= prev["l"]:
        pts -= 1
    return label, pts


def _chart_score(bars: list[dict]) -> dict:
    """Recency-weighted score over the bar sequence, normalized to -1..+1."""
    labels: list[str] = []
    raw, wsum = 0.0, 0.0
    for i in range(1, len(bars)):
        label, pts = _compare(bars[i - 1], bars[i])
        w = float(i)
        raw += w * pts
        wsum += w
        labels.append(label)
    norm = raw / (5.0 * wsum) if wsum else 0.0
    flip = (
        len(labels) >= 2
        and labels[-1] == "UP"
        and labels[-2] == "UP"
        and any(lb in ("DOWN", "INSIDE", "OUTSIDE") for lb in labels[:-2])
    )
    return {"labels": labels, "norm": norm, "flip": flip}


def _verdict(norm: float) -> str:
    if norm >= 0.50:
        return "STRONG UP"
    if norm >= 0.20:
        return "UP"
    if norm <= -0.50:
        return "STRONG DOWN"
    if norm <= -0.20:
        return "DOWN"
    return "MIXED"


def _bar_color(bar: dict | None) -> str:
    if not bar:
        return "none"
    if bar["c"] > bar["o"]:
        return "green"
    if bar["c"] < bar["o"]:
        return "red"
    return "doji"


# ---------------------------------------------------------------------------
# Timeline helpers
# ---------------------------------------------------------------------------


def _bars_in_minute_window(bars: list[dict], start_min: int, end_min: int) -> list[dict]:
    """Bars whose START minute lies in [start_min, end_min] inclusive."""
    out = []
    for b in bars:
        t = datetime.fromtimestamp(b["ts"], tz=IST_TZ)
        m = t.hour * 60 + t.minute
        if start_min <= m <= end_min:
            out.append(b)
    return out


def _bar_at(bars: list[dict], hhmm: tuple[int, int]) -> dict | None:
    want = _minutes(hhmm)
    for b in bars:
        t = datetime.fromtimestamp(b["ts"], tz=IST_TZ)
        if t.hour * 60 + t.minute == want:
            return b
    return None


def _entry_bar(bars: list[dict], entry_hhmm: tuple[int, int]) -> dict | None:
    return _bar_at(bars, entry_hhmm)


def _ts_minute(ts: int) -> int:
    """IST minute-of-day of a timestamp (bar START)."""
    t = datetime.fromtimestamp(ts, tz=IST_TZ)
    return t.hour * 60 + t.minute


def _exit_price(bars: list[dict], exit_hhmm: tuple[int, int]) -> float | None:
    """Realistic exit fill: the open of the exit bar, else the close of the
    last bar before it (the strategy's 15:29:00 market order)."""
    b = _bar_at(bars, exit_hhmm)
    if b:
        return b["o"]
    prev = None
    want = _minutes(exit_hhmm)
    for bar in bars:
        t = datetime.fromtimestamp(bar["ts"], tz=IST_TZ)
        if t.hour * 60 + t.minute < want:
            prev = bar
    return prev["c"] if prev else None


# ---------------------------------------------------------------------------
# Strike universe (generic - any index or F&O underlying)
# ---------------------------------------------------------------------------


def _infer_strike_step(strikes: list[float], spot: float) -> float:
    """Smallest gap between consecutive listed strikes near the spot."""
    near = [s for s in strikes if spot * 0.7 <= s <= spot * 1.3]
    if len(near) < 2:
        near = sorted(strikes)
    diffs = [b - a for a, b in zip(near, near[1:], strict=False) if b > a]
    if not diffs:
        return 0.0
    return float(min(diffs))


def _side_atm(strikes_sorted: list[float], spot: float, side: str) -> float:
    """The side's OWN ATM strike (per-side, one-strike-difference convention).

    CE: the closest listed strike AT/BELOW the spot (floor). PE: the closest
    listed strike AT/ABOVE the spot (ceil). When the spot sits exactly on a
    listed strike both sides get that same strike. Clamps to the ladder edge
    when the spot is outside the listed range.
    """
    if side == SIDE_CE:
        below = [s for s in strikes_sorted if s <= spot]
        return float(below[-1]) if below else float(strikes_sorted[0])
    above = [s for s in strikes_sorted if s >= spot]
    return float(above[0]) if above else float(strikes_sorted[-1])


def _moneyness(side: str, offset: int) -> tuple[str, int]:
    """Classify a leg for the UI: ('ITM'|'ATM'|'OTM', otm_steps 0..6)."""
    if offset == 0:
        return "ATM", 0
    itm = offset < 0 if side == SIDE_CE else offset > 0
    if itm:
        return "ITM", 0
    return "OTM", abs(offset)


def _resolve_universe(
    underlying: str,
    fo_exchange: str,
    expiry: str,
    spot_ref: float,
) -> dict:
    """Per side: ONE ITM strike + ATM + SIX OTM strikes, with symbols/lot size.

    Everything comes from the master contract: step inferred from the listed
    strikes, each side's ATM picked per the per-side convention (CE = strike
    at/below spot, PE = strike at/above spot - they are one strike apart when
    the spot is between two strikes), symbols constructed in OpenAlgo format
    and verified against SymToken.
    """
    ce_strikes = get_available_strikes(underlying, expiry, SIDE_CE, fo_exchange)
    if not ce_strikes:
        return {"error": f"No option strikes found for {underlying} {expiry} on {fo_exchange}"}

    strikes_sorted = sorted(float(s) for s in ce_strikes)
    step = _infer_strike_step(strikes_sorted, spot_ref)
    if step <= 0:
        step = float(FALLBACK_STRIKE_STEPS.get(underlying.upper(), 0)) or 50.0

    # Per-side ATMs (see module docstring): CE floor strike, PE ceil strike.
    ce_atm = _side_atm(strikes_sorted, spot_ref, SIDE_CE)
    pe_atm = _side_atm(strikes_sorted, spot_ref, SIDE_PE)
    side_atms = {SIDE_CE: ce_atm, SIDE_PE: pe_atm}

    # Walk outward from EACH side's own ATM collecting offset strikes that
    # exist. lo/hi walk independently per side so ladder-edge clamping cannot
    # bleed across sides.
    picked: dict[tuple[str, int], float] = {}
    for side in (SIDE_CE, SIDE_PE):
        s_atm = side_atms[side]
        s_idx = strikes_sorted.index(s_atm)
        lo, hi = s_idx, s_idx
        for off in SIDE_OFFSETS[side]:
            if off < 0:
                lo = max(0, lo - 1)
                picked[(side, off)] = strikes_sorted[lo]
            elif off > 0:
                hi = min(len(strikes_sorted) - 1, hi + 1)
                picked[(side, off)] = strikes_sorted[hi]
            else:
                picked[(side, 0)] = s_atm

    expiry_db = f"{expiry[:2]}-{expiry[2:5]}-{expiry[5:]}".upper()
    legs = []
    lot_size = 0
    try:
        from database.symbol import SymToken
        from database.symbol import db_session as symbol_session
    except Exception as e:  # pragma: no cover
        logger.exception(f"castrade: symbol DB unavailable: {e}")
        symbol_session = None

    for side in (SIDE_CE, SIDE_PE):
        for off in SIDE_OFFSETS[side]:
            strike = picked[(side, off)]
            moneyness, otm_steps = _moneyness(side, off)
            symbol = construct_option_symbol(underlying, expiry, strike, side)
            ls = 0
            exists = True
            if symbol_session is not None:
                try:
                    rec = (
                        symbol_session.query(SymToken)
                        .filter(
                            SymToken.symbol == symbol,
                            SymToken.exchange == fo_exchange,
                        )
                        .first()
                    )
                    exists = rec is not None
                    if rec is not None and rec.lotsize:
                        ls = int(rec.lotsize)
                        lot_size = lot_size or ls
                except Exception as e:
                    logger.exception(f"castrade: symbol lookup failed for {symbol}: {e}")
                    exists = True
            legs.append(
                {
                    "offset": off,
                    "moneyness": moneyness,
                    "otm_steps": otm_steps,
                    "strike": float(strike),
                    "side": side,
                    "symbol": symbol,
                    "exists": exists,
                    "lot_size": ls,
                }
            )

    return {
        "atm": float(ce_atm),  # legacy single-ATM key (kept for older clients)
        "ce_atm": float(ce_atm),
        "pe_atm": float(pe_atm),
        "strike_step": step,
        "legs": legs,
        "lot_size": lot_size,
        "expiry_db": expiry_db,
    }


# ---------------------------------------------------------------------------
# The engine - replay of the strategy timeline over one day of candles
# ---------------------------------------------------------------------------


def _cond_a_state(
    legs_by_key: dict, side_atms: dict, step: float, window_bars_by_key: dict
) -> dict:
    """Cond A crash filter over the near-ATM basket per side.

    Base = first window reading of the average near-ATM premium (near-ATM =
    within 2 x step of THAT side's own ATM); a side whose basket low falls
    CRASH_DROP_PCT below the base is banned for the day.
    """
    state = {}
    for side in (SIDE_CE, SIDE_PE):
        series = []
        n_window = max((len(v) for v in window_bars_by_key.values()), default=0)
        for i in range(n_window):
            total, n = 0.0, 0
            for key, leg in legs_by_key.items():
                if leg["side"] != side:
                    continue
                if abs(leg["strike"] - side_atms[side]) > 2 * step:
                    continue
                bars = window_bars_by_key.get(key) or []
                if i < len(bars):
                    total += bars[i]["c"]
                    n += 1
            if n:
                series.append(total / n)
        base = series[0] if series else None
        low = min(series) if series else None
        banned = bool(base and low is not None and low <= base * (1.0 - CRASH_DROP_PCT / 100.0))
        state[side] = {
            "base": base,
            "low": low,
            "banned": banned,
            "drop_pct": (
                ((base - low) / base * 100.0) if (base and low is not None and base > 0) else 0.0
            ),
        }
    return state


def _side_votes(window_bars_by_key: dict, legs_by_key: dict, cond_a: dict) -> dict:
    ce_total = 0.0
    pe_total = 0.0
    for key, bars in window_bars_by_key.items():
        leg = legs_by_key[key]
        if len(bars) < 3:
            continue
        norm = _chart_score(bars)["norm"]
        if leg["side"] == SIDE_CE:
            ce_total += norm
        else:
            pe_total += norm
    winning = None
    if ce_total > WIN_THRESHOLD and pe_total < -WIN_THRESHOLD and not cond_a[SIDE_CE]["banned"]:
        winning = SIDE_CE
    elif pe_total > WIN_THRESHOLD and ce_total < -WIN_THRESHOLD and not cond_a[SIDE_PE]["banned"]:
        winning = SIDE_PE
    return {"ce": ce_total, "pe": pe_total, "winning": winning}


def _mirror_leg(
    legs_by_key: dict, side_atms: dict, opp: str, step: float
) -> dict | None:
    """The opposite side's leg to buy when the cross-side pattern fires.

    The mirror is the OPPOSITE SIDE'S OWN ATM strike - with the per-side ATM
    convention this is exactly the same rung of the ladder as the red side's
    near-ATM (one strike apart when the spot sits between two strikes), and it
    is the strike that behaves like the spot on that side. Example (spot
    22760.75): red at 22750 CE (CE's ATM) -> mirror = 22800 PE (PE's ATM) -
    never 22750 PE, which is an OTM put on the wrong side of the ladder and
    would decay to zero. Fallbacks when the ATM leg is missing: the opposite
    side's first OTM, then its ITM.
    """
    atm = side_atms[opp]
    if opp == SIDE_CE:
        candidates = [atm, atm + step, atm - step, atm + 2 * step]
    else:
        candidates = [atm, atm - step, atm + step, atm - 2 * step]
    for strike in candidates:
        leg = legs_by_key.get((strike, opp))
        if leg is not None and leg.get("tradable", True):
            return leg
    return None


def _cross_side_pattern(
    legs_by_key: dict,
    side_atms: dict,
    step: float,
    pattern_hhmm: tuple[int, int],
    decision_hhmm: tuple[int, int],
    cond_a: dict,
) -> dict:
    """The 15:19/15:20 red/green cross-side confirmation.

    On one side: that side's near-ATM candle RED at the pattern bar while >=1
    other strike on that side is GREEN; at the decision bar that side is still
    green (at least half the greens held). Entry = the OPPOSITE side's OWN ATM
    strike (see _mirror_leg).
    """
    red_side_ce_first = (SIDE_CE, SIDE_PE)
    for red_side in red_side_ce_first:
        opp = SIDE_PE if red_side == SIDE_CE else SIDE_CE
        red_atm = side_atms[red_side]
        near = legs_by_key.get((red_atm, red_side))
        near_bar = near and _bar_at(near["window_bars"], pattern_hhmm)
        if not near_bar:
            continue
        red19 = near_bar["c"] < near_bar["o"]
        greens = []
        for leg in legs_by_key.values():
            if leg["side"] != red_side or leg["strike"] == red_atm:
                continue
            gb = _bar_at(leg["window_bars"], pattern_hhmm)
            if gb and gb["c"] > gb["o"]:
                greens.append(leg)
        if not (red19 and greens):
            continue
        still = []
        for g in greens:
            db_ = _bar_at(g["window_bars"], decision_hhmm)
            if db_ and db_["c"] > db_["o"]:
                still.append(g)
        if len(still) < max(1, math.ceil(len(greens) / 2.0)):
            return {
                "found": False,
                "reason": (
                    f"pattern seen on {red_side} at {_fmt_hhmm(pattern_hhmm)} "
                    f"but the side did not stay green at {_fmt_hhmm(decision_hhmm)}"
                ),
                "red_side": red_side,
            }
        if REQUIRE_BOTH_SIDES_CLEAN and (cond_a[red_side]["banned"] or cond_a[opp]["banned"]):
            return {
                "found": False,
                "reason": "pattern present but a Cond A ban is active",
                "red_side": red_side,
            }
        mirror = _mirror_leg(legs_by_key, side_atms, opp, step)
        if mirror is None or not mirror.get("tradable", True):
            continue
        last_p = mirror["window_bars"][-1]["c"] if mirror["window_bars"] else None
        if last_p is None or last_p < MIN_PREMIUM:
            return {
                "found": False,
                "reason": (f"mirror strike {mirror['symbol']} not tradable (premium {last_p})"),
                "red_side": red_side,
            }
        return {
            "found": True,
            "red_side": red_side,
            "mirror_strike": mirror["strike"],
            "mirror_side": opp,
            "mirror_symbol": mirror["symbol"],
            "greens": [g["strike"] for g in greens],
            "still_green": [g["strike"] for g in still],
            "reason": (
                f"cross-side: {_fmt_hhmm(pattern_hhmm)} red at near-ATM "
                f"{red_atm:g} {red_side} while {len(greens)} strike(s) green, "
                f"{_fmt_hhmm(decision_hhmm)} stayed green -> mirror {opp} "
                f"ATM {mirror['strike']:g}"
            ),
        }
    return {"found": False, "reason": "no cross-side red/green pattern", "red_side": None}


def _scoring_pick(
    legs_by_key: dict,
    side: str,
    decision_hhmm: tuple[int, int],
    spot_now: float | None,
    avg_gain: float | None,
) -> tuple[dict | None, str]:
    """Phase-1 fallback: rank the winning side's strikes by projected % return."""
    if side is None:
        return None, "side vote mixed or banned"
    if spot_now is None or avg_gain is None:
        return None, "no deep-ITM CE feed for the spot projection"
    spot_hat = spot_now + avg_gain * EXIT_BARS * DECAY
    rows = []
    for leg in legs_by_key.values():
        if leg["side"] != side or not leg.get("tradable", True):
            continue
        bars = leg["window_bars"]
        if len(bars) < 3:
            continue
        sc = _chart_score(bars)
        now_p = bars[-1]["c"]
        if side == SIDE_CE:
            intrinsic = max(spot_hat - leg["strike"], 0.0)
        else:
            intrinsic = max(leg["strike"] - spot_hat, 0.0)
        proj = intrinsic + 0.5 if intrinsic > 0 else MIN_TICK
        pct = (proj - now_p) / now_p * 100.0 if now_p > 0 else 0.0
        rows.append(
            {
                "leg": leg,
                "now": now_p,
                "proj": proj,
                "pct": pct,
                "verdict": _verdict(sc["norm"]),
                "flip": sc["flip"],
                "norm": sc["norm"],
            }
        )
    winners = [
        r
        for r in rows
        if r["verdict"] in ("UP", "STRONG UP")
        and r["proj"] > MIN_TICK
        and r["pct"] > 0
        and r["now"] >= MIN_PREMIUM
    ]
    winners.sort(key=lambda r: -r["pct"])
    if not winners:
        return None, f"side {side} won the vote but no eligible strike"
    b = winners[0]
    return {
        "leg": b["leg"],
        "spot_hat": spot_hat,
        "projected_pct": b["pct"],
        "fresh_flip": b["flip"],
    }, "scoring: best projected return on the vote-winning side"


def _deepest_itm_ce(legs_by_key: dict) -> dict | None:
    best, best_p = None, -1.0
    for leg in legs_by_key.values():
        if leg["side"] != SIDE_CE or not leg["window_bars"]:
            continue
        p = leg["window_bars"][-1]["c"]
        if p > best_p:
            best, best_p = leg, p
    return best


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_cas_analysis(
    underlying: str,
    fo_exchange: str,
    expiry: str,
    trade_date: str,
    api_key: str,
    window_start: str = DEFAULT_WINDOW_START,
    entry_time: str = DEFAULT_ENTRY_TIME,
    exit_time: str = DEFAULT_EXIT_TIME,
) -> tuple[bool, dict, int]:
    """Run the full CAS timeline replay for one underlying/day.

    Returns (success, response_dict, http_status) for the page API.
    """
    try:
        response, status_code = _run_cas_analysis_inner(
            underlying,
            fo_exchange,
            expiry,
            trade_date,
            api_key,
            window_start,
            entry_time,
            exit_time,
        )
        return str(response.get("status")) == "success", response, status_code
    except Exception as e:
        logger.exception(f"castrade analysis failed for {underlying} {trade_date}: {e}")
        return False, {"status": "error", "message": f"Analysis failed: {e}"}, 500


def _run_cas_analysis_inner(
    underlying,
    fo_exchange,
    expiry,
    trade_date,
    api_key,
    window_start,
    entry_time,
    exit_time,
):
    underlying = underlying.strip().upper()
    fo_exchange = fo_exchange.strip().upper()
    expiry = _normalize_expiry(expiry)
    trade_date = trade_date.strip()

    if fo_exchange not in VALID_FO_EXCHANGES:
        return {"status": "error", "message": f"Invalid exchange: {fo_exchange}"}, 400

    ws_hhmm = _parse_hhmm(window_start, (15, 15))
    entry_hhmm = _parse_hhmm(entry_time, (15, 21))
    exit_hhmm = _parse_hhmm(exit_time, (15, 29))
    pattern_hhmm = (entry_hhmm[0], entry_hhmm[1] - 2)
    decision_hhmm = (entry_hhmm[0], entry_hhmm[1] - 1)
    if pattern_hhmm[1] < 0:
        pattern_hhmm = (pattern_hhmm[0] - 1, pattern_hhmm[1] + 60)
    if decision_hhmm[1] < 0:
        decision_hhmm = (decision_hhmm[0] - 1, decision_hhmm[1] + 60)

    # --- underlying candles (spot reference + chart) -----------------------
    quote_symbol, quote_exchange = _underlying_quote(underlying, fo_exchange)
    if not quote_symbol and fo_exchange in ("MCX", "CDS"):
        quote_symbol = _resolve_future_symbol(underlying, fo_exchange)
        quote_exchange = fo_exchange

    underlying_bars: list[dict] = []
    if quote_symbol:
        try:
            underlying_bars = _fetch_candles(quote_symbol, quote_exchange, trade_date, api_key)
        except Exception as e:
            logger.warning(f"castrade: underlying history failed for {quote_symbol}: {e}")
            underlying_bars = []

    # Spot at the window start: the close of the last bar before the window's
    # first bar (15:15 bar close ~= the price the strategy captures at 15:16).
    spot_ref = None
    ws_min = _minutes(ws_hhmm)
    for b in underlying_bars:
        t = datetime.fromtimestamp(b["ts"], tz=IST_TZ)
        m = t.hour * 60 + t.minute
        if m <= ws_min:
            spot_ref = b["c"]
        else:
            break
    if spot_ref is None and underlying_bars:
        spot_ref = underlying_bars[-1]["c"]

    # Live-quote fallback (useful intraday before the window starts).
    if spot_ref is None:
        try:
            from services.quotes_service import get_quotes

            ok, qresp, _sc = get_quotes(
                symbol=quote_symbol or underlying,
                exchange=quote_exchange or fo_exchange,
                api_key=api_key,
            )
            if ok and isinstance(qresp, dict):
                spot_ref = _to_float((qresp.get("data") or {}).get("ltp"))
        except Exception as e:
            logger.warning(f"castrade: quote fallback failed: {e}")

    if not spot_ref or spot_ref <= 0:
        return {
            "status": "error",
            "message": (
                "No spot reference available for the underlying "
                f"({quote_symbol or underlying}). Check the broker feed."
            ),
        }, 400

    # --- strike universe ----------------------------------------------------
    uni = _resolve_universe(underlying, fo_exchange, expiry, spot_ref)
    if "error" in uni:
        return {"status": "error", "message": uni["error"]}, 400

    ce_atm = uni["ce_atm"]
    pe_atm = uni["pe_atm"]
    step = uni["strike_step"]
    lot_size = uni["lot_size"]

    # --- leg candles ----------------------------------------------------------
    legs_by_key: dict[tuple[float, str], dict] = {}
    candles_by_key: dict[tuple[float, str], list[dict]] = {}
    day_min_start = 9 * 60
    day_min_end = 15 * 60 + 30
    failed = []
    for leg in uni["legs"]:
        key = (leg["strike"], leg["side"])
        if not leg["exists"]:
            legs_by_key[key] = {**leg, "tradable": False, "day_bars": [], "window_bars": []}
            candles_by_key[key] = []
            continue
        try:
            bars = _fetch_candles(leg["symbol"], fo_exchange, trade_date, api_key)
        except Exception as e:
            logger.warning(f"castrade: history failed for {leg['symbol']}: {e}")
            bars = []
        if not bars:
            failed.append(leg["symbol"])
        day_bars = [b for b in bars if day_min_start <= _ts_minute(b["ts"]) <= day_min_end]
        window_bars = _bars_in_minute_window(day_bars, _minutes(ws_hhmm), _minutes(decision_hhmm))
        legs_by_key[key] = {
            **leg,
            "tradable": True,
            "day_bars": day_bars,
            "window_bars": window_bars,
        }
        candles_by_key[key] = day_bars

    if not any(leg["tradable"] and leg["window_bars"] for leg in legs_by_key.values()):
        msg = (
            "No option candles available for the window "
            f"{_fmt_hhmm(ws_hhmm)}-{_fmt_hhmm(decision_hhmm)} on {trade_date}. "
            "Check the history subscription for option symbols."
        )
        return {"status": "error", "message": msg}, 400

    # --- Cond A + votes -----------------------------------------------------
    window_map = {k: leg["window_bars"] for k, leg in legs_by_key.items()}
    side_atms = {SIDE_CE: ce_atm, SIDE_PE: pe_atm}
    cond_a = _cond_a_state(legs_by_key, side_atms, step, window_map)

    # Spot now (decision bar) and window gain from the deepest-ITM CE closes,
    # exactly like the strategy's projection feed.
    feed = _deepest_itm_ce(legs_by_key)
    spot_now = spot_ref
    avg_gain = None
    if feed and len(feed["window_bars"]) >= 2:
        closes = [b["c"] for b in feed["window_bars"]]
        spot_now = closes[-1] + feed["strike"] - TV_OF_DEEP_ITM
        n = len(closes) - 1
        avg_gain = (closes[-1] - closes[0]) / n if n else 0.0
        if spot_ref is None:
            spot_ref = closes[0] + feed["strike"] - TV_OF_DEEP_ITM
    elif underlying_bars:
        db_ = _bar_at(underlying_bars, decision_hhmm)
        if db_:
            spot_now = db_["c"]
        fb = _bar_at(underlying_bars, ws_hhmm)
        if db_ and fb:
            avg_gain = db_["c"] - fb["c"]

    votes = _side_votes(window_map, legs_by_key, cond_a)

    pattern = _cross_side_pattern(
        legs_by_key, side_atms, step, pattern_hhmm, decision_hhmm, cond_a
    )

    # --- picks --------------------------------------------------------------
    events: list[dict] = []
    events.append(
        {
            "time": _fmt_hhmm(ws_hhmm),
            "text": (
                f"Window opens. Spot {spot_ref:.2f} -> ATM CE {ce_atm:g} / PE {pe_atm:g}, "
                f"step {step:g}"
            ),
        }
    )
    for side in (SIDE_CE, SIDE_PE):
        s = cond_a[side]
        if s["banned"]:
            events.append(
                {
                    "time": _fmt_hhmm(decision_hhmm),
                    "text": (
                        f"Cond A: {side} basket crashed {s['drop_pct']:.0f}% "
                        f"(base {s['base']:.2f} -> low {s['low']:.2f}) - side banned"
                    ),
                }
            )
    events.append(
        {
            "time": _fmt_hhmm(pattern_hhmm),
            "text": (
                f"Cross-side scan: {pattern['reason']}"
                if pattern.get("reason")
                else "Cross-side scan done"
            ),
        }
    )
    events.append(
        {
            "time": _fmt_hhmm(decision_hhmm),
            "text": (
                f"Side votes: CE {votes['ce']:+.2f} / PE {votes['pe']:+.2f} "
                f"(threshold {WIN_THRESHOLD:+.2f})"
                + (f" -> {votes['winning']} side" if votes["winning"] else " -> no vote")
            ),
        }
    )

    pick = None
    pick_source = None
    pick_reason = None
    projected_pct = None
    spot_hat = None
    if spot_now is not None and avg_gain is not None:
        spot_hat = spot_now + avg_gain * EXIT_BARS * DECAY
    if pattern["found"]:
        pick = legs_by_key.get((pattern["mirror_strike"], pattern["mirror_side"]))
        pick_source = "pattern"
        pick_reason = pattern["reason"]
        events.append({"time": _fmt_hhmm(decision_hhmm), "text": f"PATTERN pick: {pick_reason}"})
    else:
        sc_leg, sc_why = _scoring_pick(
            legs_by_key, votes["winning"], decision_hhmm, spot_now, avg_gain
        )
        if sc_leg is not None:
            pick = sc_leg["leg"]
            pick_source = "scoring"
            pick_reason = sc_why
            projected_pct = sc_leg["projected_pct"]
            flip_note = " (FRESH FLIP)" if sc_leg["fresh_flip"] else ""
            events.append(
                {
                    "time": _fmt_hhmm(decision_hhmm),
                    "text": f"SCORING pick{flip_note}: {pick_reason}",
                }
            )
        else:
            events.append({"time": _fmt_hhmm(decision_hhmm), "text": f"NO TRADE - {sc_why}"})

    # --- actual outcomes (replay validation) --------------------------------
    def _outcome(leg: dict) -> dict | None:
        if not leg["tradable"]:
            return None
        eb = _entry_bar(leg["day_bars"], entry_hhmm)
        if not eb:
            return None
        entry_p = eb["o"]
        exit_p = _exit_price(leg["day_bars"], exit_hhmm)
        if not entry_p or exit_p is None or entry_p <= 0:
            return None
        pts = exit_p - entry_p
        return {
            "entry_price": entry_p,
            "exit_price": exit_p,
            "pnl_per_unit": pts,
            "pct": pts / entry_p * 100.0,
        }

    # --- assemble the leg payload ------------------------------------------
    # Strike values come straight from the listed ladder (not synthesized),
    # so the output walks the actual legs in the per-side matrix order
    # (1 ITM, ATM, then the OTMs walking away from ATM).
    legs_out = []
    for side in (SIDE_CE, SIDE_PE):
        for off in SIDE_OFFSETS[side]:
            matches = [
                cand
                for cand in legs_by_key.values()
                if cand["offset"] == off and cand["side"] == side
            ]
            if not matches:
                continue
            leg = matches[0]
            key = (leg["strike"], side)
            bars = candles_by_key.get(key) or []
            window = leg["window_bars"]
            sc = (
                _chart_score(window)
                if len(window) >= 2
                else {"labels": [], "norm": 0.0, "flip": False}
            )
            b19 = _bar_at(window, pattern_hhmm)
            b20 = _bar_at(window, decision_hhmm)
            projected = None
            if projected_pct is not None and pick is not None and pick is leg:
                projected = projected_pct
            elif leg["tradable"] and window and spot_hat is not None:
                now_p = window[-1]["c"]
                intrinsic = (
                    max(spot_hat - leg["strike"], 0.0)
                    if side == SIDE_CE
                    else max(leg["strike"] - spot_hat, 0.0)
                )
                proj = intrinsic + 0.5 if intrinsic > 0 else MIN_TICK
                projected = (proj - now_p) / now_p * 100.0 if now_p > 0 else 0.0
            outcome = _outcome(leg)
            candles = [
                {
                    "time": ((b["ts"] + IST_OFFSET_SECONDS) // 60) * 60,
                    "open": b["o"],
                    "high": b["h"],
                    "low": b["l"],
                    "close": b["c"],
                }
                for b in bars
            ]
            moneyness, otm_steps = _moneyness(side, off)
            legs_out.append(
                {
                    "offset": off,
                    "moneyness": moneyness,
                    "otm_steps": otm_steps,
                    "strike": leg["strike"],
                    "side": side,
                    "symbol": leg["symbol"],
                    "exists": leg["exists"],
                    "tradable": leg["tradable"],
                    "score": round(sc["norm"], 3),
                    "verdict": _verdict(sc["norm"]),
                    "flip": sc["flip"],
                    "blocked": bool(cond_a[side]["banned"]),
                    "bar_pattern": {**b19, "color": _bar_color(b19)} if b19 else None,
                    "bar_decision": {**b20, "color": _bar_color(b20)} if b20 else None,
                    "premium_at_decision": window[-1]["c"] if window else None,
                    "projected_pct": round(projected, 2) if projected is not None else None,
                    "actual": (
                        {
                            "entry_price": round(outcome["entry_price"], 2),
                            "exit_price": round(outcome["exit_price"], 2),
                            "pnl_per_unit": round(outcome["pnl_per_unit"], 2),
                            "pct": round(outcome["pct"], 2),
                        }
                        if outcome
                        else None
                    ),
                    "candles": candles,
                }
            )

    # --- final trade ----------------------------------------------------------
    trade_date_dt = None
    try:
        trade_date_dt = datetime.strptime(trade_date, "%Y-%m-%d")
    except ValueError:
        pass

    # Live vs replay: live means the requested date is today and the session
    # may still be running (entry may not have happened yet).
    is_live = False
    if trade_date_dt is not None:
        # Compare against IST now.
        try:
            import pytz

            ist_now = datetime.now(pytz.timezone("Asia/Kolkata"))
        except Exception:  # pragma: no cover
            ist_now = datetime.now()
        is_live = trade_date_dt.date() == ist_now.date()

    final_trade = None
    no_trade_reason = None
    if pick is not None:
        outcome = _outcome(pick)
        pending = is_live and outcome is None
        entry_p = (
            outcome["entry_price"]
            if outcome
            else (pick["window_bars"][-1]["c"] if pick["window_bars"] else None)
        )
        exit_p = outcome["exit_price"] if outcome else None
        final_trade = {
            "side": pick["side"],
            "strike": pick["strike"],
            "symbol": pick["symbol"],
            "source": pick_source,
            "reason": pick_reason,
            "entry_time": _fmt_hhmm(entry_hhmm),
            "exit_time": _fmt_hhmm(exit_hhmm),
            "entry_price": round(entry_p, 2) if entry_p else None,
            "exit_price": round(exit_p, 2) if exit_p else None,
            "pnl_per_unit": round(outcome["pnl_per_unit"], 2) if outcome else None,
            "pct": round(outcome["pct"], 2) if outcome else projected_pct,
            "projected_pct": round(projected_pct, 2) if projected_pct is not None else None,
            "lot_size": lot_size,
            "pending": pending,
        }
    else:
        no_trade_reason = next(
            (e["text"] for e in reversed(events) if e["text"].startswith("NO TRADE")),
            "No qualified entry for the day",
        )

    if failed:
        events.append(
            {
                "time": "--:--",
                "text": f"No candles for {len(failed)} leg(s): {', '.join(failed[:6])}",
            }
        )

    expiry_dt = _parse_expiry_date(expiry)
    is_expiry_day = bool(expiry_dt and trade_date_dt and expiry_dt.date() == trade_date_dt.date())

    underlying_candles = [
        {
            "time": ((b["ts"] + IST_OFFSET_SECONDS) // 60) * 60,
            "open": b["o"],
            "high": b["h"],
            "low": b["l"],
            "close": b["c"],
        }
        for b in underlying_bars
        if day_min_start <= _ts_minute(b["ts"]) <= day_min_end
    ]

    data = {
        "underlying": underlying,
        "fo_exchange": fo_exchange,
        "quote_symbol": quote_symbol,
        "quote_exchange": quote_exchange,
        "expiry": expiry,
        "trade_date": trade_date,
        "is_expiry_day": is_expiry_day,
        "mode": "live" if is_live else "replay",
        "atm": ce_atm,  # legacy single-ATM key (CE side)
        "ce_atm": ce_atm,
        "pe_atm": pe_atm,
        "strike_step": step,
        "lot_size": lot_size,
        "window": {
            "start": _fmt_hhmm(ws_hhmm),
            "pattern_bar": _fmt_hhmm(pattern_hhmm),
            "decision_bar": _fmt_hhmm(decision_hhmm),
            "entry": _fmt_hhmm(entry_hhmm),
            "exit": _fmt_hhmm(exit_hhmm),
        },
        "spot": {
            "at_window_start": round(spot_ref, 2) if spot_ref else None,
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
            "CE": {
                "base": round(cond_a["CE"]["base"], 2) if cond_a["CE"]["base"] else None,
                "low": round(cond_a["CE"]["low"], 2) if cond_a["CE"]["low"] is not None else None,
                "banned": cond_a["CE"]["banned"],
                "drop_pct": round(cond_a["CE"]["drop_pct"], 1),
            },
            "PE": {
                "base": round(cond_a["PE"]["base"], 2) if cond_a["PE"]["base"] else None,
                "low": round(cond_a["PE"]["low"], 2) if cond_a["PE"]["low"] is not None else None,
                "banned": cond_a["PE"]["banned"],
                "drop_pct": round(cond_a["PE"]["drop_pct"], 1),
            },
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
        "final_trade": final_trade,
        "no_trade_reason": no_trade_reason,
        "events": events,
        "legs": legs_out,
        "underlying_candles": underlying_candles,
        "analyzer_mode": bool(get_analyze_mode()),
    }
    return {"status": "success", "data": data}, 200


def get_castrade_underlyings() -> list[dict]:
    """Supported underlyings for the page dropdown (indices first)."""
    data = []
    for name in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"):
        if name in NSE_INDEX_UNDERLYINGS:
            data.append({"underlying": name, "fo_exchange": "NFO", "quote_exchange": "NSE_INDEX"})
        else:
            data.append({"underlying": name, "fo_exchange": "BFO", "quote_exchange": "BSE_INDEX"})
    return data


def get_castrade_expiries(
    underlying: str, fo_exchange: str, api_key: str
) -> tuple[bool, dict, int]:
    """Expiry list (DDMMMYY) for the page dropdown."""
    success, response, status_code = get_expiry_dates(
        symbol=underlying, exchange=fo_exchange, instrumenttype="options", api_key=api_key
    )
    if not success:
        return success, response, status_code
    raw = response.get("data", []) or []
    normalized = [_normalize_expiry(d) for d in raw]

    # Soonest first.
    def _key(e: str):
        d = _parse_expiry_date(e)
        return d or datetime.max

    normalized = sorted(normalized, key=_key)
    return True, {"status": "success", "data": normalized}, 200
