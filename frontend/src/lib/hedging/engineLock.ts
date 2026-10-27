import { useCallback, useEffect, useState } from 'react'

/**
 * The scheduler engines' cross-tab lock.
 *
 * A firing engine lives in the page that owns its batches — the hedging
 * terminal fires its boards, the charting terminal fires its deploy ladder.
 * But browsers open the same page in two tabs, and two engines reading the
 * same store would place every due batch twice. So each engine claims a
 * per-scope lock in localStorage before its tick: a timestamped heartbeat
 * that only one live tab can hold. A stale heartbeat (a closed or frozen
 * tab) is claimable again within seconds, so the surviving tab takes over.
 *
 * Storage refused (private mode, quota) reads as a single-tab session: the
 * engine runs, accepting that two such tabs could double-fire rather than
 * never firing at all.
 */

const LOCK_TTL_MS = 4000

interface LockHeartbeat {
  id: string
  ts: number
}

function lockKey(scope: string): string {
  return `oa-sched-lock-${scope}`
}

/**
 * Claim (or refresh) the scope's lock for this instance. True when this
 * instance may fire this tick — it holds the lock, or the holder's
 * heartbeat is stale, or storage is refused.
 */
export function claimEngineLock(
  scope: 'hedging' | 'trading',
  instanceId: string,
  now: number = Date.now()
): boolean {
  try {
    const key = lockKey(scope)
    const raw = localStorage.getItem(key)
    const held: LockHeartbeat | null = raw ? JSON.parse(raw) : null
    if (held && held.id !== instanceId && now - held.ts < LOCK_TTL_MS) return false
    localStorage.setItem(key, JSON.stringify({ id: instanceId, ts: now } satisfies LockHeartbeat))
    return true
  } catch {
    return true
  }
}

/** Drop the lock, but only if this instance still holds it. */
export function releaseEngineLock(scope: 'hedging' | 'trading', instanceId: string): void {
  try {
    const key = lockKey(scope)
    const raw = localStorage.getItem(key)
    if (!raw) return
    const held = JSON.parse(raw) as LockHeartbeat
    if (held?.id === instanceId) localStorage.removeItem(key)
  } catch {
    // Unreadable lock: nothing to release.
  }
}

/**
 * A random per-mount instance id. The initializer runs exactly once per
 * mount, which is the lifetime the lock cares about.
 */
export function useEngineInstanceId(): string {
  const [id] = useState(
    () => `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  )
  return id
}

/**
 * The engine's side of the lock as a hook: claims every tick through
 * `claim()`, releases on unmount, and lets the caller decide what a lost
 * claim means (usually: skip the tick quietly).
 */
export function useEngineLock(scope: 'hedging' | 'trading') {
  const id = useEngineInstanceId()
  useEffect(() => {
    return () => releaseEngineLock(scope, id)
  }, [scope, id])
  const claim = useCallback((): boolean => claimEngineLock(scope, id), [scope, id])
  return claim
}
