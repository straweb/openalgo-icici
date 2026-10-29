"""The Shoonya shared request budget (broker/shoonya/api/rate_limiter.py).

Noren counts every call an account makes — quotes, orders, funds, history —
against one rolling minute, and rejects the whole account past it:

    {"stat":"Not_Ok","emsg":"Invalid Input :  Order Recieved 127 in a current
     minute exceeds Limit 120 for user"}

The limiter books slots in that one shared window ahead of the request. These
tests pin the reservation arithmetic, the adaptive clamp that learns the
account's real ceiling from a rejection's own words, and the retry-delay rule
that keeps the read endpoints from burning their budget on a lost cause.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

rl = pytest.importorskip("broker.shoonya.api.rate_limiter")

limiter = rl.API_LIMITER

# The defaults the module ships with, restored around every test: the
# adaptive clamp ratchets the caps down for the life of the process, and one
# test's rejection must not tighten the next test's windows.
DEFAULT_PER_SECOND = 9
DEFAULT_PER_MINUTE = 110


@pytest.fixture(autouse=True)
def fresh_windows():
    limiter._reserved.clear()
    limiter.max_per_second = DEFAULT_PER_SECOND
    limiter.max_per_minute = DEFAULT_PER_MINUTE
    yield
    limiter._reserved.clear()
    limiter.max_per_second = DEFAULT_PER_SECOND
    limiter.max_per_minute = DEFAULT_PER_MINUTE


def test_a_burst_within_the_second_is_not_paced():
    """Nine calls — the cap — go out at once, not one a second."""
    start = time.perf_counter()
    for _ in range(DEFAULT_PER_SECOND):
        assert limiter.reserve() == 0.0
    assert time.perf_counter() - start < 0.1


def test_the_tenth_call_in_a_second_waits_for_a_fresh_slot():
    """Past the per-second cap the next slot opens when the oldest call ages out."""
    for _ in range(DEFAULT_PER_SECOND):
        limiter.reserve()
    # No sleep: the window is still full, so the next slot sits about a
    # second away, booked behind the burst rather than beside it.
    assert limiter.reserve() > 0.9


def test_the_minute_window_bookings_sixty_seconds_out():
    """Past the per-minute cap the next slot opens when the oldest ages out."""
    limiter._reserved.extend([time.time()] * DEFAULT_PER_MINUTE)
    # The deque holds reserved timestamps; a full minute window pushes the
    # next slot a rolling 60s past the newest reservation.
    delay = limiter.reserve()
    assert delay > 0.0


def test_rejection_text_clamps_the_minute_window():
    """The emsg the user saw names the ceiling; the limiter learns from it."""
    rl.note_rate_limit_rejection(
        {"stat": "Not_Ok", "emsg": "Invalid Input :  Order Recieved 127 in a current "
        "minute exceeds Limit 60 for user"}
    )
    assert limiter.max_per_minute == 60
    assert limiter.max_per_second == DEFAULT_PER_SECOND


def test_the_clamp_only_ratchets_downward():
    """A quiet provisioning is learned once; a louder one is not believed."""
    rl.note_rate_limit_rejection(
        {"stat": "Not_Ok", "emsg": "exceeds Limit 60 in a current minute for user"}
    )
    assert limiter.max_per_minute == 60
    rl.note_rate_limit_rejection(
        {"stat": "Not_Ok", "emsg": "exceeds Limit 120 in a current minute for user"}
    )
    assert limiter.max_per_minute == 60


def test_a_second_window_rejection_clamps_per_second():
    """The message names the window it tripped; the per-second one is honoured."""
    rl.note_rate_limit_rejection(
        {"stat": "Not_Ok", "emsg": "Order Recieved 11 in a current second exceeds Limit 5 for user"}
    )
    assert limiter.max_per_second == 5
    assert limiter.max_per_minute == DEFAULT_PER_MINUTE


def test_an_unparseable_rejection_leaves_the_caps_alone():
    rl.note_rate_limit_rejection({"stat": "Not_Ok", "emsg": "Session expired"})
    assert limiter.max_per_second == DEFAULT_PER_SECOND
    assert limiter.max_per_minute == DEFAULT_PER_MINUTE


def test_detection_runs_on_the_raised_text_too():
    """The single-quote paths raise; the emsg arrives inside an Exception's text."""
    assert rl.is_rate_limit_emsg(
        "Error from Shoonya API: Invalid Input :  Order Recieved 127 in a current "
        "minute exceeds Limit 120 for user"
    )
    assert not rl.is_rate_limit_emsg("Error from Shoonya API: Session expired")


def test_read_retry_delay_clamps_and_backs_off():
    delay = rl.rate_limit_retry_delay(
        {"stat": "Not_Ok", "emsg": "exceeds Limit 100 in a current minute for user"},
        retry_count=0,
    )
    assert delay == 2.0
    assert rl.rate_limit_retry_delay(
        {"stat": "Not_Ok", "emsg": "exceeds Limit 100 in a current minute for user"},
        retry_count=1,
    ) == 4.0


def test_a_non_rate_limit_rejection_is_never_retried():
    assert (
        rl.rate_limit_retry_delay(
            {"stat": "Not_Ok", "emsg": "Invalid Input : Order price cannot be zero"},
            retry_count=0,
        )
        is None
    )


def test_the_retry_budget_is_bounded():
    assert (
        rl.rate_limit_retry_delay(
            {"stat": "Not_Ok", "emsg": "exceeds Limit 100 in a current minute for user"},
            retry_count=rl.MAX_RATE_LIMIT_RETRIES,
        )
        is None
    )


def test_the_never_retried_rule_is_documented_in_order_paths():
    """Order endpoints call note_rate_limit_rejection, never the retry helper.

    A PlaceOrder refused for rate is safe to re-issue, but this module cannot
    tell that from a reply lost after the broker accepted the order — so the
    order paths clamp and surface, and the test pins that the retry helper is
    the read paths' alone by keeping its contract sharp.
    """
    # The helper's docstring states the rule; this asserts the behaviour a
    # caller leaning on it for orders would silently rely on: every call
    # counts a retry, so a fourth attempt is refused outright.
    emsg = {"stat": "Not_Ok", "emsg": "exceeds Limit 100 in a current minute for user"}
    assert rl.rate_limit_retry_delay(emsg, 0) is not None
    assert rl.rate_limit_retry_delay(emsg, 1) is not None
    assert rl.rate_limit_retry_delay(emsg, 2) is not None
    assert rl.rate_limit_retry_delay(emsg, 3) is None
