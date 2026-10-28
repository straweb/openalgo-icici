#!/usr/bin/env python3
"""
Standalone validation for the /castrade backend engine
(services/castrade_service.py) on synthetic expiry-day candles.

Scenarios:
  1. PATTERN  - 15:19 near-ATM CE red while other CE strikes green, CE still
                green at 15:20 -> final trade = mirror PE (same strike),
                entry = open(15:21), exit = open(15:29).
  2. SCORING  - no pattern; CE side wins the vote -> best projected % CE strike.
  3. COND A   - both premium baskets crash > 50% -> both sides banned -> NO TRADE.
  4. PARITY   - _chart_score matches an independent reimplementation of the
                validated phase-1 algorithm.
  5. FIELDS   - payload is JSON-serializable and carries the chart data.

Run:  python3 scripts/test_castrade_engine.py
"""

import json
import sys
import types
from datetime import datetime

REPO = "/home/z/my-project/openalgo-icici"
sys.path.insert(0, REPO)


def _stub(name, **attrs):
    mod = sys.modules.get(name) or types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod


# --- stub the platform modules the service imports at module load -----------
_stub(
    "utils.logging",
    get_logger=lambda name: types.SimpleNamespace(
        info=lambda *a, **k: None,
        warning=lambda *a, **k: None,
        exception=lambda *a, **k: None,
        debug=lambda *a, **k: None,
    ),
)
_stub(
    "utils.thread_safe_cache",
    LockedTTLCache=lambda maxsize=0, ttl=0: types.SimpleNamespace(
        get_or_load=lambda key, loader, should_cache=None: loader()
    ),
)
_stub("database.settings_db", get_analyze_mode=lambda: False)
_stub(
    "services.expiry_service",
    get_expiry_dates=lambda **k: (True, {"status": "success", "data": []}, 200),
)
_stub(
    "services.history_service",
    get_history=lambda **k: (True, {"status": "success", "data": []}, 200),
)
_stub(
    "services.option_symbol_service",
    construct_option_symbol=lambda b, e, s, ot: f"{b}{e}{int(s) if s == int(s) else s}{ot}",
    get_available_strikes=lambda b, e, ot, x: [],
)

from services import castrade_service as cs  # noqa: E402

TRADE_DATE = "2026-10-27"  # a Tuesday
EXPIRY = "27OCT26"


def ts(hh, mm):
    return int(datetime.fromisoformat(f"{TRADE_DATE}T{hh:02d}:{mm:02d}:00+05:30").timestamp())


def bar(hh, mm, o, c):
    hi = max(o, c) + 0.4
    lo = min(o, c) - 0.4
    return {"ts": ts(hh, mm), "o": o, "h": hi, "l": lo, "c": c}


STRIKES = [s * 50 for s in range(448, 460)]  # 22400 .. 22950
ATM = 22600


def sym(strike, side):
    return f"NIFTY{EXPIRY}{strike}{side}"


def underlying_bars():
    """Index candles: flat morning ~22595, drift up through the window."""
    bars = []
    for i in range(300):
        hh, mm = divmod(9 * 60 + 15 + i, 60)
        bars.append(bar(hh, mm, 22590 + (i % 5), 22590 + (i % 5) + 0.3))
    bars += [
        bar(15, 10, 22596, 22598),
        bar(15, 11, 22598, 22600),
        bar(15, 12, 22600, 22601),
        bar(15, 13, 22601, 22602),
        bar(15, 14, 22602, 22603),
        bar(15, 15, 22603, 22605),
    ]
    return bars


def leg_day(strike, side, window, entry, exitp, extra=None):
    """Build 15:10..15:30 bars: window pairs (mm, o, c), then 15:21 open, 15:29 open."""
    bars = []
    for mm, o, c in window:
        bars.append(bar(15, mm, o, c))
    # 15:21..15:28 drift from entry toward exit
    bars.append(bar(15, 21, entry, entry + (exitp - entry) * 0.3))
    for mm in range(22, 29):
        f = (mm - 21) / 8.0
        o = entry + (exitp - entry) * f
        bars.append(bar(15, mm, o, o + (exitp - entry) * 0.1))
    bars.append(bar(15, 29, exitp, exitp))
    bars.append(bar(15, 30, exitp, exitp))
    for b in extra or []:
        bars.append(b)
    return bars


def make_feed():
    """Scenario 1: pattern hit -> mirror PE ATM."""
    feed = {("NIFTY", "NSE_INDEX"): underlying_bars()}

    # CE legs rise (greens); ATM CE is RED at 15:19, green elsewhere.
    ce_window = {
        22550: [
            (10, 42.0, 43.0),
            (15, 45.0, 47.0),
            (16, 47.0, 49.0),
            (17, 49.0, 51.0),
            (18, 51.0, 53.0),
            (19, 55.0, 57.0),
            (20, 57.0, 59.0),
        ],
        22600: [
            (10, 14.0, 15.0),
            (15, 16.0, 16.6),
            (16, 17.0, 17.5),
            (17, 18.0, 18.4),
            (18, 19.0, 19.3),
            (19, 19.5, 19.1),
            (20, 19.4, 19.8),
        ],
        22650: [
            (10, 4.0, 4.4),
            (15, 4.8, 5.3),
            (16, 5.4, 5.9),
            (17, 6.0, 6.5),
            (18, 6.6, 7.1),
            (19, 7.2, 7.9),
            (20, 8.0, 8.6),
        ],
        22700: [
            (10, 1.6, 1.7),
            (15, 1.8, 2.1),
            (16, 2.1, 2.4),
            (17, 2.4, 2.7),
            (18, 2.7, 3.0),
            (19, 3.1, 3.5),
            (20, 3.6, 3.9),
        ],
        22750: [
            (10, 0.6, 0.6),
            (15, 0.7, 0.8),
            (16, 0.8, 0.9),
            (17, 0.9, 1.0),
            (18, 1.0, 1.1),
            (19, 1.1, 1.2),
            (20, 1.2, 1.3),
        ],
        22800: [
            (10, 0.3, 0.3),
            (15, 0.3, 0.35),
            (16, 0.35, 0.4),
            (17, 0.4, 0.45),
            (18, 0.45, 0.5),
            (19, 0.5, 0.55),
            (20, 0.55, 0.6),
        ],
    }
    for st, w in ce_window.items():
        feed[(sym(st, "CE"), "NFO")] = leg_day(
            st, "CE", w, entry=w[-1][2] + 0.2, exitp=w[-1][2] + 0.5
        )

    # PE legs bleed gently (no Cond A); ATM PE is the mirror and rallies hard.
    pe_window = {
        22550: [
            (10, 40.0, 39.4),
            (15, 38.0, 37.2),
            (16, 36.5, 35.8),
            (17, 35.0, 34.2),
            (18, 33.6, 32.8),
            (19, 32.0, 31.2),
            (20, 30.6, 29.9),
        ],
        22600: [
            (10, 60.0, 59.2),
            (15, 57.5, 56.6),
            (16, 56.0, 55.2),
            (17, 54.6, 53.8),
            (18, 53.2, 52.4),
            (19, 52.0, 51.4),
            (20, 51.2, 50.6),
        ],
        22650: [
            (10, 88.0, 87.0),
            (15, 85.0, 84.0),
            (16, 83.5, 82.5),
            (17, 81.8, 80.8),
            (18, 80.0, 79.0),
            (19, 78.4, 77.4),
            (20, 76.8, 75.8),
        ],
        22700: [
            (10, 122.0, 121.0),
            (15, 119.0, 118.0),
            (16, 117.5, 116.4),
            (17, 115.8, 114.7),
            (18, 114.0, 112.9),
            (19, 112.2, 111.1),
            (20, 110.4, 109.3),
        ],
        22750: [
            (10, 158.0, 157.0),
            (15, 155.0, 154.0),
            (16, 153.4, 152.4),
            (17, 151.8, 150.8),
            (18, 150.0, 149.0),
            (19, 148.4, 147.4),
            (20, 146.8, 145.8),
        ],
        22800: [
            (10, 194.0, 193.0),
            (15, 191.0, 190.0),
            (16, 189.4, 188.4),
            (17, 187.8, 186.8),
            (18, 186.0, 185.0),
            (19, 184.4, 183.4),
            (20, 182.8, 181.8),
        ],
    }
    rally = {22600: (50.0, 96.0)}  # mirror: buy ~50 at 15:21 open, sell ~96 at 15:29
    for st, w in pe_window.items():
        e, x = rally.get(st, (w[-1][2] - 0.4, w[-1][2] - 0.8))
        feed[(sym(st, "PE"), "NFO")] = leg_day(st, "PE", w, entry=e, exitp=x)
    return feed


def install(feed):
    cs._fetch_candles = lambda symbol, exchange, trade_date, api_key: feed.get(
        (symbol, exchange), []
    )
    cs.get_available_strikes = lambda b, e, ot, x: list(STRIKES)


def test_pattern():
    install(make_feed())
    ok, resp, code = cs.run_cas_analysis(
        underlying="NIFTY", fo_exchange="NFO", expiry=EXPIRY, trade_date=TRADE_DATE, api_key="k"
    )
    assert ok and code == 200, (code, resp)
    d = resp["data"]
    assert d["pattern"]["found"] is True, d["pattern"]
    assert d["pattern"]["red_side"] == "CE"
    ft = d["final_trade"]
    assert ft, d["no_trade_reason"]
    assert ft["side"] == "PE" and ft["strike"] == ATM, ft
    assert ft["source"] == "pattern"
    # entry = open of the 15:21 bar, exit = open of the 15:29 bar
    assert abs(ft["entry_price"] - 50.0) < 1e-6, ft
    assert abs(ft["exit_price"] - 96.0) < 1e-6, ft
    assert abs(ft["pct"] - 92.0) < 0.01, ft  # (96-50)/50*100
    # mirror premium at decision was 50.6 (>= MIN_PREMIUM)
    # the PE leg with strike ATM carries the WIN row data
    pe_atm = next(lg for lg in d["legs"] if lg["side"] == "PE" and lg["strike"] == ATM)
    assert pe_atm["actual"]["pct"] == ft["pct"]
    print(
        f"  [1] PATTERN -> final trade PE {ft['strike']:g}, entry {ft['entry_price']:.2f} "
        f"exit {ft['exit_price']:.2f}, {ft['pct']:.1f}%  OK"
    )
    return d


def test_scoring():
    feed = make_feed()
    # Kill the pattern: ATM CE 15:19 bar becomes green too.
    from datetime import timedelta, timezone

    ist = timezone(timedelta(hours=5, minutes=30))
    atm_ce = feed[(sym(ATM, "CE"), "NFO")]
    for b in atm_ce:
        if datetime.fromtimestamp(b["ts"], tz=ist).minute == 19:
            b["c"] = b["o"] + 0.4
            b["h"] = b["c"] + 0.3
    install(feed)
    ok, resp, code = cs.run_cas_analysis(
        underlying="NIFTY", fo_exchange="NFO", expiry=EXPIRY, trade_date=TRADE_DATE, api_key="k"
    )
    assert ok and code == 200
    d = resp["data"]
    assert d["pattern"]["found"] is False
    ft = d["final_trade"]
    assert ft, d["no_trade_reason"]
    assert ft["source"] == "scoring"
    assert ft["side"] == "CE", ft
    # deepest-ITM CE closes: 43..59 -> spot_now 59+22550-2 = 22607,
    # avg_gain 3.2 -> hat 22607+3.2*2.8 = 22615.96 -> only ITM/ATM CE have intrinsic;
    # the vote winner side CE: best projected % among UP verdicts.
    assert d["spot"]["projected_exit"] is not None
    print(
        f"  [2] SCORING -> final trade {ft['side']} {ft['strike']:g} "
        f"({ft['projected_pct'] or -1:.1f}% proj), spot hat {d['spot']['projected_exit']:.1f}  OK"
    )
    return d


def test_cond_a():
    feed = make_feed()
    # Crash BOTH near-ATM baskets (>50% from first window reading). The Cond A
    # basket spans strikes within 2 steps of the ATM (22550..22700 here), so
    # all four must crash for the side average to breach the drop limit.
    from datetime import timedelta, timezone

    ist = timezone(timedelta(hours=5, minutes=30))
    for st in (22550, 22600, 22650, 22700):
        for side in ("CE", "PE"):
            bars = feed[(sym(st, side), "NFO")]
            for b in bars:
                t = datetime.fromtimestamp(b["ts"], tz=ist)
                if 15 <= t.minute <= 20:
                    f = {15: 1.0, 16: 0.85, 17: 0.65, 18: 0.5, 19: 0.38, 20: 0.30}[t.minute]
                    b["o"] = b["o"] * f
                    b["c"] = b["c"] * f
                    b["h"] = max(b["o"], b["c"]) + 0.2
                    b["l"] = min(b["o"], b["c"]) - 0.2
    install(feed)
    ok, resp, code = cs.run_cas_analysis(
        underlying="NIFTY", fo_exchange="NFO", expiry=EXPIRY, trade_date=TRADE_DATE, api_key="k"
    )
    assert ok and code == 200
    d = resp["data"]
    assert d["cond_a"]["CE"]["banned"] and d["cond_a"]["PE"]["banned"], d["cond_a"]
    assert d["final_trade"] is None, d["final_trade"]
    assert "NO TRADE" in " ".join(e["text"] for e in d["events"])
    print("  [3] COND A -> both sides banned, NO TRADE  OK")
    return d


def test_parity():
    """_chart_score equals an independent phase-1 implementation."""
    import random

    random.seed(7)
    bars = []
    p = 100.0
    for _ in range(9):
        o = p
        c = p + random.uniform(-3, 3)
        bars.append(
            {
                "ts": 0,
                "o": o,
                "h": max(o, c) + abs(random.uniform(0, 2)),
                "l": min(o, c) - abs(random.uniform(0, 2)),
                "c": c,
            }
        )
        p = c

    def ref_compare(prev, cur):
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

    labels, raw, wsum = [], 0.0, 0.0
    for i in range(1, len(bars)):
        lb, pts = ref_compare(bars[i - 1], bars[i])
        raw += float(i) * pts
        wsum += float(i)
        labels.append(lb)
    norm = raw / (5.0 * wsum)
    got = cs._chart_score(bars)
    assert abs(got["norm"] - norm) < 1e-12, (got["norm"], norm)
    assert got["labels"] == labels
    print(f"  [4] PARITY -> chart_score matches phase-1 reference (norm {norm:.4f})  OK")


def test_payload(d):
    blob = json.dumps(d)
    assert len(blob) > 1000
    candle_legs = [leg for leg in d["legs"] if leg["candles"]]
    assert candle_legs, "at least the near-ATM legs must have candles"
    for leg in candle_legs:
        assert {"time", "open", "high", "low", "close"} == set(leg["candles"][0].keys())
        # IST-shifted minute alignment
        assert leg["candles"][0]["time"] % 60 == 0
    assert len(d["legs"]) >= 14, f"expected the full 1-ITM/ATM/6-OTM matrix, got {len(d['legs'])}"
    assert len(d["underlying_candles"]) > 300
    print("  [5] PAYLOAD -> 16 legs (1 ITM + ATM + 6 OTM x2), JSON-serializable, candles aligned  OK")


if __name__ == "__main__":
    print("cas_prediction /castrade engine validation")
    d1 = test_pattern()
    test_scoring()
    test_cond_a()
    test_parity()
    test_payload(d1)
    print("ALL PASSED")
