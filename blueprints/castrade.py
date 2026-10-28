"""
CAS Trade Blueprint - expiry-day CAS prediction terminal (/castrade).

Serves ONLY the /castrade page: session-authenticated JSON endpoints that
resolve the underlying/expiry and run the CAS prediction timeline replay
(scoring + 15:19/15:20 cross-side confirmation + Cond A + projection) over
one day of 1-minute candles. All heavy lifting lives in
services/castrade_service.py; this blueprint holds no strategy logic.

Order constants context (same vocabulary as the scalping terminal):
- Underlying quote exchange : NSE_INDEX / BSE_INDEX (indices), NSE / BSE (stocks)
- Leg exchange              : NFO / BFO / MCX / CDS
This page is read-only: it computes and displays the final winning trade
(buy 15:21, sell 15:29) and never places orders.
"""

from flask import Blueprint, jsonify, request, session
from flask_cors import cross_origin

from database.auth_db import get_api_key_for_tradingview
from services.castrade_service import (
    DEFAULT_ENTRY_TIME,
    DEFAULT_EXIT_TIME,
    DEFAULT_WINDOW_START,
    get_castrade_expiries,
    get_castrade_underlyings,
    run_cas_analysis,
)
from utils.logging import get_logger
from utils.session import check_session_validity

logger = get_logger(__name__)

castrade_bp = Blueprint("castrade_bp", __name__, url_prefix="/")


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
