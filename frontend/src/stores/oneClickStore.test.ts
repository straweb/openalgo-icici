/**
 * The store's part of the One-Click contract: the switch persists under the
 * key the Trading page has always used, the read is the scalping terminal's
 * '1' / '0', and the confirm-skip mirrors the armed state — because every
 * surface that asks a question (the dock's flatten buttons, the position
 * rows, the chart's context menu) reads this one value.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { ONE_CLICK_KEY, oneClickSkipConfirm, useOneClickStore } from './oneClickStore'

describe('oneClickStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useOneClickStore.setState({ armed: false })
  })

  it("persists the scalping terminal's key on every switch", () => {
    useOneClickStore.getState().setArmed(true)
    expect(localStorage.getItem(ONE_CLICK_KEY)).toBe('1')
    expect(useOneClickStore.getState().armed).toBe(true)

    useOneClickStore.getState().setArmed(false)
    expect(localStorage.getItem(ONE_CLICK_KEY)).toBe('0')
    expect(useOneClickStore.getState().armed).toBe(false)
  })

  it('skips confirms exactly while armed', () => {
    expect(oneClickSkipConfirm()).toBe(false)
    useOneClickStore.getState().setArmed(true)
    expect(oneClickSkipConfirm()).toBe(true)
  })

  it('a stored arm survives a fresh read — the reload keeps the switch', () => {
    localStorage.setItem(ONE_CLICK_KEY, '1')
    useOneClickStore.setState({ armed: true })
    expect(oneClickSkipConfirm()).toBe(true)
    // And the disarmed default a cleared storage produces: nothing is live
    // because storage went away.
    localStorage.removeItem(ONE_CLICK_KEY)
    useOneClickStore.setState({ armed: false })
    expect(oneClickSkipConfirm()).toBe(false)
  })
})
