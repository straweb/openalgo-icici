"""One shared request budget for every Shoonya HTTP entry point.

Shoonya runs the Noren platform, and Noren budgets ALL of an account's
requests — quotes, orders, funds, history — against one rolling window. The
rejection that proves it arrived on a GetQuotes call:

    {"stat":"Not_Ok","emsg":"Invalid Input :  Order Recieved 127 in a current
     minute exceeds Limit 120 for user"}

— "Order Recieved" is Noren-speak for "request received", the counter had
counted every endpoint's calls, and the reply came from a market-data route.
So one limiter, not two: pacing quotes against an order window would throttle
them pointlessly, and pacing orders against a quote window would let a burst
of quotes push a placement past its turn. Everything shares the one window,
which is the only way a shared budget can actually be shared.

Before this module the only pacing in the plugin was the 1s sleep between
20-symbol multiquotes batches (data.py) — up to 20 requests a second inside a
batch, on top of the books the UI polls and the ticks the strategy feed
pulls, against a broker ceiling of 120 a minute. A single 202-symbol option
chain refresh (~11 batches) is enough to breach it, and the whole batch came
back as per-symbol errors.

**Defaults are the observed ceiling minus a margin, not a published table.**
Shoonya publishes no rate-limit page; the 120/min figure is read off live
rejections, and 10/sec is the general budget the Noren siblings publish
(Flattrade 14-rate-limits.md, TradeSmart's rate_limiter.py — same platform).
9/sec and 110/min, the same margin TradeSmart uses, leave room for clock skew
between our rolling windows and Noren's. Set SHOONYA_MAX_PER_SECOND /
SHOONYA_MAX_PER_MINUTE to raise them for an account provisioned higher; the
adaptive clamp below still ratchets the caps down if the broker disagrees.

**Adaptive clamping.** When a rejection names its ceiling anyway — wording,
spelling and all shared with Flattrade, since it is the same backend —

    "Order Recieved 127 in a current minute exceeds Limit 120 for user"

— ``note_rate_limit_rejection`` parses the ``Limit N`` and clamps the window
the message names for the rest of the process. The clamp only ratchets
downward and is logged once per move, so a quieter provisioning is learned on
the first rejection instead of paid for on every one.
"""

from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from collections import deque

from utils.broker_backpressure import cap_server_delay, check_queue_wait
from utils.logging import get_logger

logger = get_logger(__name__)


def _env_int(name: str, default: int, ceiling: int) -> int:
    """Read a positive int from the environment, bounded by `ceiling`.

    The ceilings here are sanity rails rather than a published table (there
    is none): an override that sits above anything the Noren family has ever
    published is treated as a typo — a stray zero on "110" silently disables
    the pacing this module exists to provide.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        logger.warning(f"{name}={raw!r} is not an integer; using {default}")
        return default
    if value < 1:
        logger.warning(f"{name}={value} must be >= 1; using {default}")
        return default
    if value > ceiling:
        logger.warning(
            f"{name}={value} is above the sanity ceiling of {ceiling}; using {ceiling}. "
            "An account genuinely provisioned higher should say so in the plugin docs, "
            "not in an env var that reads like a count of zeros."
        )
        return ceiling
    return value


# Shoonya's rejection text — the Noren grammar shared with Flattrade and
# TradeSmart, down to the misspelling of "Received" (matched case-insensitively;
# only "exceeds Limit N" is actually captured).
_LIMIT_IN_MESSAGE = re.compile(r"exceeds\s+limit\s+(\d+)", re.IGNORECASE)
_PER_SECOND_HINT = re.compile(r"current\s+second", re.IGNORECASE)
_PER_MINUTE_HINT = re.compile(r"current\s+minute", re.IGNORECASE)


class SlidingWindowLimiter:
    """Dual rolling-window limiter: bursts to the per-second cap, hard-capped
    on both windows.

    Reservation happens inside the lock; sleeping is the caller's job, outside
    the lock, so concurrent threads queue without serializing on the lock.

    The deque holds reserved call timestamps in non-decreasing order (each new
    reservation is >= the previous by construction). The earliest permissible
    slot is now, 1s after the Nth-most-recent reservation when the per-second
    window is full, or 60s after the Mth-most-recent when the per-minute
    window is full — whichever is latest. Entries older than 60s can no
    longer constrain any future slot and are purged.
    """

    def __init__(
        self, name: str, max_per_second: int, max_per_minute: int, kind: str = "data"
    ):
        self.name = name
        self.max_per_second = max_per_second
        self.max_per_minute = max_per_minute
        #: Which wait bound applies under the gthread worker (utils.broker_backpressure).
        self.kind = kind
        self._lock = threading.Lock()
        self._reserved: deque[float] = deque()

    def reserve(self) -> float:
        """Reserve the earliest slot satisfying both windows.

        Returns the seconds the caller must sleep before issuing its request.

        Past the per-minute cap every extra caller is booked about one slot
        after the previous one. Under the gthread worker each of those sleeps
        holds a request thread, so a caller whose slot is further away than
        the data wait ceiling is refused at once — before anything is booked,
        so it delays nobody behind it. Under eventlet and the dev server
        there is no bound and every caller is booked as before.

        Raises:
            BrokerBusyError: Under gthread, when the slot is too far away.
        """
        with self._lock:
            now = time.time()
            while self._reserved and self._reserved[0] <= now - 60.0:
                self._reserved.popleft()

            slot = now
            if len(self._reserved) >= self.max_per_second:
                slot = max(slot, self._reserved[-self.max_per_second] + 1.0)
            if len(self._reserved) >= self.max_per_minute:
                slot = max(slot, self._reserved[-self.max_per_minute] + 60.0)

            check_queue_wait(slot - now, self.kind)
            self._reserved.append(slot)
            return slot - now

    def acquire(self) -> None:
        """Block until this caller's reserved slot arrives."""
        sleep_time = self.reserve()
        if sleep_time > 0:
            logger.debug(
                f"Rate limiting ({self.name}): sleeping {sleep_time:.2f}s "
                "before Shoonya API call"
            )
            time.sleep(sleep_time)

    async def acquire_async(self) -> None:
        """Same reservation, awaiting asyncio.sleep so the loop is not blocked."""
        sleep_time = self.reserve()
        if sleep_time > 0:
            await asyncio.sleep(sleep_time)

    def clamp_per_second(self, limit: int) -> bool:
        """Lower the per-second cap to `limit`. Ratchets down only."""
        with self._lock:
            if limit < 1 or limit >= self.max_per_second:
                return False
            previous = self.max_per_second
            self.max_per_second = limit
        logger.warning(
            f"Shoonya reported a per-second limit of {limit}; lowering the local "
            f"{self.name} cap from {previous} to {limit} for the rest of this process. "
            "Set SHOONYA_MAX_PER_SECOND to pin this explicitly and avoid the first rejection."
        )
        return True

    def clamp_per_minute(self, limit: int) -> bool:
        """Lower the per-minute cap to `limit`. Ratchets down only."""
        with self._lock:
            if limit < 1 or limit >= self.max_per_minute:
                return False
            previous = self.max_per_minute
            self.max_per_minute = limit
        logger.warning(
            f"Shoonya reported a per-minute limit of {limit}; lowering the local "
            f"{self.name} cap from {previous} to {limit} for the rest of this process."
        )
        return True


# The one budget every Shoonya call shares — see the module docstring for why
# there is exactly one.
API_LIMITER = SlidingWindowLimiter(
    "api",
    max_per_second=_env_int("SHOONYA_MAX_PER_SECOND", 9, ceiling=40),
    max_per_minute=_env_int("SHOONYA_MAX_PER_MINUTE", 110, ceiling=200),
)


def is_rate_limit_emsg(emsg: str) -> bool:
    """Whether a Shoonya emsg (or a whole exception text) is a rate-limit rejection."""
    return "exceeds limit" in str(emsg).lower()


def note_rate_limit_rejection(response) -> None:
    """Teach `API_LIMITER` the ceiling Shoonya just named in its rejection.

    Accepts a parsed response dict or any string carrying the emsg (the batch
    paths return per-symbol error dicts, the single-quote paths raise). A
    no-op unless the text actually carries a "Limit N", so an unparseable
    rejection leaves the configured caps alone.
    """
    if isinstance(response, dict):
        emsg = str(response.get("emsg", ""))
    else:
        emsg = str(response)
    match = _LIMIT_IN_MESSAGE.search(emsg)
    if not match:
        return
    try:
        limit = int(match.group(1))
    except (TypeError, ValueError):
        return

    # The message says which window it tripped. When it says neither, assume
    # per-second: that is the window a burst trips first, and clamping it
    # also holds the per-minute rate down.
    if _PER_MINUTE_HINT.search(emsg) and not _PER_SECOND_HINT.search(emsg):
        API_LIMITER.clamp_per_minute(limit)
    else:
        API_LIMITER.clamp_per_second(limit)


MAX_RATE_LIMIT_RETRIES = 3
RATE_LIMIT_BASE_DELAY = 2.0  # seconds, doubled per attempt: 2, 4, 8


def rate_limit_retry_delay(response, retry_count: int, context: str = "") -> float | None:
    """Clamp from a rejection and return how long to wait before retrying.

    For read endpoints only: a GetQuotes refused for rate is safe to re-issue,
    because nothing happened. Order endpoints must NOT retry through this —
    a PlaceOrder whose response was lost after the broker accepted it looks
    identical to one rejected for rate, and a duplicate order is far worse
    than a failed one.

    Returns None when `response` was not a rate-limit rejection, or when the
    retry budget is spent, or when the wait would exceed the server's delay
    ceiling under the gthread worker (``cap_server_delay``) — in every case
    the caller returns the rejection it already has.
    """
    if isinstance(response, dict):
        emsg = str(response.get("emsg", ""))
        if not is_rate_limit_emsg(emsg):
            return None
    elif not is_rate_limit_emsg(str(response)):
        return None

    note_rate_limit_rejection(response)
    if retry_count >= MAX_RATE_LIMIT_RETRIES:
        logger.warning(
            f"Shoonya rate limit still hit after {MAX_RATE_LIMIT_RETRIES} retries"
            f"{f' on {context}' if context else ''}; giving up. The cap is now "
            f"{API_LIMITER.max_per_second}/sec, {API_LIMITER.max_per_minute}/min."
        )
        return None

    delay = RATE_LIMIT_BASE_DELAY * (2**retry_count)
    bounded = cap_server_delay(delay)
    if bounded is None:
        return None
    logger.warning(
        f"Shoonya rate limit hit{f' on {context}' if context else ''} ({emsg}). "
        f"Retrying in {bounded:.0f}s (attempt {retry_count + 1}/{MAX_RATE_LIMIT_RETRIES})"
    )
    return bounded
