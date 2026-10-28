import { useEffect, useRef } from 'react'
import { tradingApi } from '@/api/trading'
import { useEngineLock } from '@/lib/hedging/engineLock'
import {
  activeBrackets,
  advanceBracket,
  type CloseOrderPlan,
  type DeployBracket,
  upsertBracket,
  WORKING_ORDER_STATES,
} from '@/lib/trading/bracket'
import { readDeployState, writeDeployState } from '@/lib/trading/deployPlan'
import type { Order } from '@/types/trading'
import { showToast } from '@/utils/toast'

/**
 * The dock's bracket engine: it works the deploy panel's entry brackets —
 * the resting entry orders the trader armed with a target and a stop.
 *
 * Every couple of seconds it reads the book's active brackets, polls the
 * order and position books once for all of them, and lets the pure
 * `advanceBracket` decide: an entry that filled places the target as a
 * resting LIMIT and the stop as a resting SL-M on the closing side, sized
 * to what the position actually holds; a position that left pulls the
 * sibling close that is still working; an entry the broker rejected ends
 * its watch. The panel being closed costs nothing — this lives beside the
 * scheduler on the dock, so the bracket survives even that.
 *
 * A cross-tab lock (its own scope, so it never fights the batch scheduler
 * in the same tab) keeps two tabs of this page from doubling the closes,
 * and an already-working check keeps a lost response from re-placing them.
 */
export function useBracketEngine(apiKey: string) {
  const claimLock = useEngineLock('trading-bracket')
  const busyRef = useRef(false)
  /** One-shot toasts per bracket event, so a retry loop never spams. */
  const toldRef = useRef(new Set<string>())

  useEffect(() => {
    if (!apiKey) return
    const timer = window.setInterval(() => {
      if (busyRef.current) return
      const active = activeBrackets(readDeployState().brackets)
      if (active.length === 0) return
      if (!claimLock()) return
      busyRef.current = true
      void tick(apiKey, active, toldRef.current).finally(() => {
        busyRef.current = false
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [apiKey, claimLock])
}

/** Close placements the engine burns before it gives up and says so. */
const MAX_CLOSE_ATTEMPTS = 5

async function tick(apiKey: string, active: DeployBracket[], told: Set<string>) {
  const [ordRes, posRes] = await Promise.allSettled([
    tradingApi.getOrders(apiKey),
    tradingApi.getPositions(apiKey),
  ])
  const orders: Order[] =
    ordRes.status === 'fulfilled' && ordRes.value.status === 'success'
      ? (ordRes.value.data?.orders ?? [])
      : []
  const heldQty = new Map<string, number>()
  if (posRes.status === 'fulfilled' && posRes.value.status === 'success') {
    for (const position of posRes.value.data ?? []) {
      if (position.quantity !== 0)
        heldQty.set(`${position.exchange}:${position.symbol}`, position.quantity)
    }
  }

  for (const bracket of active) {
    // The books may have moved while the previous bracket's requests ran;
    // each decision reads the freshest persisted stage.
    const current = readDeployState().brackets.find((candidate) => candidate.id === bracket.id)
    if (!current || current.stage === 'done') continue
    const decision = advanceBracket(current, {
      orders,
      positionQty: heldQty.get(`${current.exchange}:${current.symbol}`),
      positionsKnown: posRes.status === 'fulfilled' && posRes.value.status === 'success',
    })
    let result = decision.bracket

    if (decision.place.length > 0) {
      const placed = await placeCloses(apiKey, current, decision.place, orders)
      result = {
        ...result,
        stage: placed.stage,
        closeTarget: placed.closeTarget,
        closeStop: placed.closeStop,
      }
      if (placed.failed) {
        const attempts = (current.attempts ?? 0) + 1
        result = { ...result, attempts }
        if (attempts >= MAX_CLOSE_ATTEMPTS) {
          // Something keeps rejecting the closes. Keep the armed stage when
          // at least one leg is working at the broker — the OCO cleanup
          // still owns it — and end the watch when nothing is resting.
          const anyLeg = result.closeTarget != null || result.closeStop != null
          result = { ...result, stage: anyLeg ? 'armed' : 'done' }
          const key = `${current.id}:gaveup`
          if (!told.has(key)) {
            told.add(key)
            showToast.warning(
              `${current.symbol}: the target/stop orders would not place — set them by hand`
            )
          }
        }
      } else if (result.stage === 'armed') {
        const key = `${current.id}:armed`
        if (!told.has(key)) {
          told.add(key)
          const legs = [
            current.target != null ? `target ${current.target}` : null,
            current.stoploss != null ? `SL ${current.stoploss}` : null,
          ]
            .filter(Boolean)
            .join(' / ')
          showToast.success(`${current.symbol}: filled — ${legs} resting`)
        }
      }
    }
    for (const orderid of decision.cancel) {
      try {
        await tradingApi.cancelOrder(orderid)
        const key = `${current.id}:pulled`
        if (!told.has(key)) {
          told.add(key)
          showToast.info(`${current.symbol}: the leftover target/stop order was pulled`)
        }
      } catch {
        // Already filled or already gone — either way nothing to pull.
      }
    }
    if (current.stage === 'watch' && result.stage === 'done') {
      const key = `${current.id}:dead`
      if (!told.has(key)) {
        told.add(key)
        showToast.info(`${current.symbol}: the entry did not fill — the target/stop watch ended`)
      }
    }
    persist(current, result)
  }
}

/**
 * Place the close plans that are not already working at the broker, and
 * return the order ids the bracket should remember. A plan the book
 * already carries (a response lost the first time) is adopted, not
 * duplicated; a request that failed leaves the bracket free to retry.
 */
async function placeCloses(
  apiKey: string,
  bracket: DeployBracket,
  plans: CloseOrderPlan[],
  orders: Order[]
): Promise<{
  stage: DeployBracket['stage']
  closeTarget: string | null
  closeStop: string | null
  placedIds: number
  failed: boolean
}> {
  const ids: { closeTarget: string | null; closeStop: string | null } = {
    closeTarget: bracket.closeTarget,
    closeStop: bracket.closeStop,
  }
  let failed = false
  let placedIds = 0
  for (const plan of plans) {
    const twin = orders.find(
      (order) =>
        order.symbol === bracket.symbol &&
        order.exchange === bracket.exchange &&
        order.action === plan.action &&
        order.product === bracket.product &&
        WORKING_ORDER_STATES.includes(order.order_status) &&
        (plan.pricetype === 'LIMIT'
          ? order.pricetype === 'LIMIT' && order.price === plan.price
          : order.trigger_price === plan.trigger_price)
    )
    if (twin) {
      ids[plan.key] = twin.orderid
      continue
    }
    try {
      const res = await tradingApi.placeOrder({
        apikey: apiKey,
        strategy: 'DEPLOY',
        exchange: bracket.exchange,
        symbol: bracket.symbol,
        action: plan.action,
        quantity: plan.quantity,
        pricetype: plan.pricetype,
        product: bracket.product,
        price: plan.price,
        trigger_price: plan.trigger_price,
      })
      if (res.status === 'success') {
        ids[plan.key] = res.data?.orderid ?? ids[plan.key]
        placedIds += 1
      } else failed = true
    } catch {
      failed = true
    }
  }
  if (failed)
    return {
      stage: 'watch',
      closeTarget: ids.closeTarget,
      closeStop: ids.closeStop,
      placedIds,
      failed,
    }
  return {
    stage: 'armed',
    closeTarget: ids.closeTarget,
    closeStop: ids.closeStop,
    placedIds,
    failed: false,
  }
}

/** Write one bracket's next stage through a fresh read of the book. */
function persist(current: DeployBracket, result: DeployBracket) {
  if (
    current.stage === result.stage &&
    current.closeTarget === result.closeTarget &&
    current.closeStop === result.closeStop &&
    (current.attempts ?? 0) === (result.attempts ?? 0)
  )
    return
  try {
    const fresh = readDeployState()
    writeDeployState({
      ...fresh,
      brackets: upsertBracket(fresh.brackets, result),
    })
  } catch {
    // Persistence refused: the watch retries with what it knows.
  }
}
