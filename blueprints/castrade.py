"""
CAS Trade Blueprint - expiry-day CAS prediction terminal (/castrade).

Serves ONLY the /castrade page: session-authenticated JSON endpoints that
resolve the underlying/expiry and run the CAS prediction timeline (scoring +
15:19/15:20 cross-side confirmation + Cond A + projection). Two run modes:

- REPLAY  (POST /castrade/api/analyze): one day of 1-minute candles from the
  history API, the validated timeline replay. Read-only.
- LIVE    (POST /castrade/api/live/start): a tick-by-tick session backed by
  services/castrade_live.py - broker feed ticks build the forming 1-minute
  bars, the engine re-runs on every tick and the final pick is pushed to the
  page as socket.io ``castrade_update`` events.
- ORDERS  (POST /castrade/api/order): BUY/SELL MARKET orders for any tradable
  strike of the live session universe (the final pick via the Final Trade
  panel, or ANY strike row via its quick B/S buttons), via the standard
  place_order service (honors analyzer/sandbox mode). Strategy tag:
  "castrade".
- FUNDS   (GET  /castrade/api/funds): available funds for the page's
  "% of available amount" slider that sizes quick orders in whole lots.

Order constants context (same vocabulary as the scalping terminal):
- Underlying quote exchange : NSE_INDEX / BSE_INDEX (indices), NSE / BSE (stocks)
- Leg exchange              : NFO / BFO / MCX / CDS
"""

from flask import Blueprint, jsonify, request, session
from flask_cors import cross_origin

from database.auth_db import get_api_key_for_tradingview
from services.castrade_live import MAX_LOTS, STRATEGY_TAG, get_castrade_live_manager
from services.castrade_service import (
    DEFAULT_ENTRY_TIME,
    DEFAULT_EXIT_TIME,
    DEFAULT_WINDOW_START,
    _to_float,
    get_castrade_expiries,
    get_castrade_underlyings,
    run_cas_analysis,
)
from utils.logging import get_logger
from utils.session import check_session_validity

logger = get_logger(__name__)

castrade_bp = Blueprint("castrade_bp", __name__, url_prefix="/")

# Absolute per-order sanity ceiling (mirrors the scalping terminal).
MAX_ORDER_QUANTITY = 100_000


def _get_api_key():
    """Resolve the current user's OpenAlgo API key from the session."""
    username = session.get("user")
    if not username:
        return None
    return get_api_key_for_tradingview(username)


@castrade_bp.route("/castrade/api/underlyings", methods=["GET"])
@cross_origin()
@check_session_validity
def underlyings():
    """Underlyings the terminal dropdown offers, with their exchanges."""
    return jsonify({"status": "success", "data": get_castrade_underlyings()})


@castrade_bp.route("/castrade/api/expiry", methods=["GET"])
@cross_origin()
@check_session_validity
def expiry():
    """Expiry dates (DDMMMYY, soonest first) for an underlying on its F&O exchange."""
    underlying = (request.args.get("underlying") or "").strip().upper()
    fo_exchange = (request.args.get("exchange") or "").strip().upper()
    if not underlying:
        return jsonify({"status": "error", "message": "underlying is required"}), 400

    api_key = _get_api_key()
    if not api_key:
        return jsonify(
            {
                "status": "error",
                "message": "API key not configured. Generate one at /apikey",
            }
        ), 401

    success, response, status_code = get_castrade_expiries(
        underlying=underlying, fo_exchange=fo_exchange, api_key=api_key
    )
    return jsonify(response), status_code


@castrade_bp.route("/castrade/api/analyze", methods=["POST"])
@cross_origin()
@check_session_validity
def analyze():
    """Run the CAS prediction timeline replay for one underlying/day.

    Body:
        underlying    : e.g. NIFTY (required)
        exchange      : NFO / BFO / MCX / CDS (required)
        expiry        : DDMMMYY (required)
        trade_date    : YYYY-MM-DD (default: today IST on the server)
        window_start  : HH:MM scoring window start (default 15:15)
        entry_time    : HH:MM buy bar (default 15:21)
        exit_time     : HH:MM sell bar (default 15:29)
    """
    try:
        data = request.get_json(silent=True) or {}

        broker = session.get("broker")
        if not broker:
            return jsonify({"status": "error", "message": "Broker not set in session"}), 400

        api_key = _get_api_key()
        if not api_key:
            return jsonify(
                {
                    "status": "error",
                    "message": "API key not configured. Generate one at /apikey",
                }
            ), 401

        underlying = str(data.get("underlying") or "").strip().upper()
        fo_exchange = str(data.get("exchange") or "").strip().upper()
        expiry = str(data.get("expiry") or "").strip()
        trade_date = str(data.get("trade_date") or "").strip()

        if not underlying or not fo_exchange or not expiry:
            return jsonify(
                {
                    "status": "error",
                    "message": "underlying, exchange and expiry are required",
                }
            ), 400

        if not trade_date:
            try:
                from datetime import datetime as _dt

                import pytz

                trade_date = _dt.now(pytz.timezone("Asia/Kolkata")).strftime("%Y-%m-%d")
            except Exception:  # pragma: no cover
                from datetime import datetime as _dt

                trade_date = _dt.now().strftime("%Y-%m-%d")

        success, response, status_code = run_cas_analysis(
            underlying=underlying,
            fo_exchange=fo_exchange,
            expiry=expiry,
            trade_date=trade_date,
            api_key=api_key,
            window_start=str(data.get("window_start") or DEFAULT_WINDOW_START),
            entry_time=str(data.get("entry_time") or DEFAULT_ENTRY_TIME),
            exit_time=str(data.get("exit_time") or DEFAULT_EXIT_TIME),
        )
        return jsonify(response), status_code

    except Exception as e:
        logger.exception(f"Error in castrade analyze API: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ---------------------------------------------------------------------------
# LIVE tick-by-tick session
# ---------------------------------------------------------------------------


def _live_common_guard():
    """Return (username, broker, api_key) or an error response tuple."""
    username = session.get("user")
    broker = session.get("broker")
    if not username or not broker:
        return None, None, None, ({"status": "error", "message": "Broker not set in session"}, 400)
    api_key = _get_api_key()
    if not api_key:
        return None, None, None, (
            {
                "status": "error",
                "message": "API key not configured. Generate one at /apikey",
            },
            401,
        )
    return username, broker, api_key, None


def _today_ist() -> str:
    try:
        import pytz

        from datetime import datetime as _dt

        return _dt.now(pytz.timezone("Asia/Kolkata")).strftime("%Y-%m-%d")
    except Exception:  # pragma: no cover
        from datetime import datetime as _dt

        return _dt.now().strftime("%Y-%m-%d")


@castrade_bp.route("/castrade/api/live/start", methods=["POST"])
@cross_origin()
@check_session_validity
def live_start():
    """Start (or replace) this user's tick-by-tick live session.

    Body: underlying, exchange, expiry (required); trade_date (default today
    IST); window_start / entry_time / exit_time (defaults 15:15/15:21/15:29).
    """
    try:
        username, broker, api_key, err = _live_common_guard()
        if err:
            return jsonify(err[0]), err[1]

        data = request.get_json(silent=True) or {}
        manager = get_castrade_live_manager()
        payload, status_code = manager.start(
            username=username,
            broker=broker,
            api_key=api_key,
            underlying=str(data.get("underlying") or ""),
            fo_exchange=str(data.get("exchange") or ""),
            expiry=str(data.get("expiry") or ""),
            trade_date=str(data.get("trade_date") or "").strip() or _today_ist(),
            window_start=str(data.get("window_start") or DEFAULT_WINDOW_START),
            entry_time=str(data.get("entry_time") or DEFAULT_ENTRY_TIME),
            exit_time=str(data.get("exit_time") or DEFAULT_EXIT_TIME),
        )
        return jsonify(payload), status_code
    except Exception as e:
        logger.exception(f"Error in castrade live start: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@castrade_bp.route("/castrade/api/live/stop", methods=["POST"])
@cross_origin()
@check_session_validity
def live_stop():
    """Stop the live session and unsubscribe its symbols from the feed."""
    try:
        username, _broker, _api_key, err = _live_common_guard()
        if err:
            return jsonify(err[0]), err[1]
        get_castrade_live_manager().stop(username)
        return jsonify({"status": "success", "message": "Live session stopped"}), 200
    except Exception as e:
        logger.exception(f"Error in castrade live stop: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@castrade_bp.route("/castrade/api/live/state", methods=["GET"])
@cross_origin()
@check_session_validity
def live_state():
    """Current live snapshot (full on ?full=1, delta otherwise)."""
    try:
        username, _broker, _api_key, err = _live_common_guard()
        if err:
            return jsonify(err[0]), err[1]
        sess = get_castrade_live_manager().get(username)
        if sess is None:
            return jsonify({"status": "error", "message": "No live session"}), 404
        full = request.args.get("full") in ("1", "true", "yes")
        payload = get_castrade_live_manager().state(username, full=full)
        return jsonify({"status": "success", "data": payload}), 200
    except Exception as e:
        logger.exception(f"Error in castrade live state: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ---------------------------------------------------------------------------
# ORDERS - only the locked final pick, MARKET, whole lots
# ---------------------------------------------------------------------------


def _lot_size_for(symbol: str, exchange: str) -> int:
    from database.symbol import SymToken
    from database.symbol import db_session as symbol_session

    rec = (
        symbol_session.query(SymToken)
        .filter(SymToken.symbol == symbol, SymToken.exchange == exchange)
        .first()
    )
    if not rec or not rec.lotsize or rec.lotsize <= 0:
        return 0
    return int(rec.lotsize)


@castrade_bp.route("/castrade/api/funds", methods=["GET"])
@cross_origin()
@check_session_validity
def funds():
    """Available funds for the quick-order sizing slider.

    Returns the broker's available-cash style figure normalized to one number
    plus the raw payload. Uses the same path as the dashboard (live broker;
    in analyzer mode the sandbox answer arrives through place_order anyway,
    funds stay the real account reading).
    """
    try:
        username, broker, api_key, err = _live_common_guard()
        if err:
            return jsonify(err[0]), err[1]

        from database.auth_db import get_auth_token_broker
        from services.funds_service import get_funds_with_auth

        auth = get_auth_token_broker(api_key)
        if not auth or not auth[0]:
            return jsonify({"status": "error", "message": "Broker auth not available"}), 401
        auth_token = auth[0]

        success, response, status_code = get_funds_with_auth(auth_token, broker, None)
        if not success:
            return jsonify(response), status_code

        data = (response or {}).get("data") or {}
        available = None
        for key in (
            "availablecash",
            "available_margin",
            "availablemargin",
            "AvailableMargin",
            "net",
            "availablebalance",
        ):
            v = _to_float(data.get(key))
            if v is not None:
                available = v if available is None else max(available, v)
        return jsonify(
            {
                "status": "success",
                "data": {"available": available, "raw": data},
            }
        ), 200
    except Exception as e:
        logger.exception(f"Error in castrade funds API: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@castrade_bp.route("/castrade/api/order", methods=["POST"])
@cross_origin()
@check_session_validity
def order():
    """Place a MARKET order for a strike of the live session.

    Body: action BUY|SELL, symbol (any tradable strike of the session
    universe - the final pick OR a strike row's quick trade), lots (1..20),
    product (MIS default). The order goes through
    services.place_order_service.place_order, so analyzer/sandbox mode is
    honored exactly like the REST API.
    """
    try:
        username, _broker, api_key, err = _live_common_guard()
        if err:
            return jsonify(err[0]), err[1]

        data = request.get_json(silent=True) or {}
        action = str(data.get("action") or "").strip().upper()
        symbol = str(data.get("symbol") or "").strip().upper()
        product = str(data.get("product") or "MIS").strip().upper()
        try:
            lots = int(data.get("lots", 1))
        except (TypeError, ValueError):
            lots = 0

        if action not in ("BUY", "SELL"):
            return jsonify({"status": "error", "message": "action must be BUY or SELL"}), 400
        if not symbol:
            return jsonify({"status": "error", "message": "symbol is required"}), 400
        if product not in ("MIS", "NRML"):
            return jsonify({"status": "error", "message": "product must be MIS or NRML"}), 400
        if lots < 1 or lots > MAX_LOTS:
            return jsonify(
                {"status": "error", "message": f"lots must be between 1 and {MAX_LOTS}"}
            ), 400

        manager = get_castrade_live_manager()
        sess = manager.get(username)
        if sess is None:
            return jsonify(
                {"status": "error", "message": "No live session - start one first"}
            ), 400

        allowed, why = manager.can_trade(sess, action, symbol)
        if not allowed:
            return jsonify({"status": "error", "message": why}), 400

        leg = next(
            (l for l in sess.legs_by_key.values() if l.get("symbol") == symbol), None
        )
        lot_size = (leg or {}).get("lot_size") or _lot_size_for(symbol, sess.fo_exchange)
        if lot_size <= 0:
            return jsonify(
                {"status": "error", "message": f"Unknown symbol or lot size unavailable: {symbol}"}
            ), 400
        quantity = lots * lot_size
        if quantity > MAX_ORDER_QUANTITY:
            return jsonify(
                {"status": "error", "message": "quantity exceeds the safety limit"}
            ), 400

        from services.place_order_service import place_order

        order_data = {
            "strategy": STRATEGY_TAG,
            "symbol": symbol,
            "exchange": sess.fo_exchange,
            "action": action,
            "pricetype": "MARKET",
            "product": product,
            "quantity": quantity,
        }
        success, response, status_code = place_order(order_data=order_data, api_key=api_key)

        manager.record_order(
            username,
            {
                "time": sess.ist_now().strftime("%H:%M:%S"),
                "action": action,
                "symbol": symbol,
                "quantity": quantity if success else 0,
                "lots": lots,
                "product": product,
                "orderid": (response or {}).get("orderid"),
                "status": "success" if success else "failed",
                "message": (response or {}).get("message"),
            },
        )
        return jsonify(response), status_code
    except Exception as e:
        logger.exception(f"Error in castrade order API: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500
