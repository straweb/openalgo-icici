/**
 * One-Click, workspace-wide: the switch on the Trading page's toolbar, and
 * every surface that reads it — the dock's Cancel all / Close all and the
 * position rows' close, the chart's context menu, the deploy panel.
 *
 * The rule the store encodes: One-Click ON means the trader has asked to
 * trade without re-confirmation, so the confirm dialogs step out of the way
 * everywhere, not only on the chart whose switch was pressed. OFF keeps
 * every guard it had. Disarming is never required to close out: the
 * risk-reducing actions still work either way, they just ask first when
 * One-Click is off.
 *
 * The persisted form is the scalping terminal's convention ('1' / '0') under
 * the key the Trading page has always used, so the state survives a reload
 * exactly as it did when the page owned the key — and off whenever the key
 * is unreadable: no surface opens with its buttons live because storage was
 * cleared or blocked.
 */

import { create } from 'zustand'

export const ONE_CLICK_KEY = 'oa-trading-armed'

function readArmed(): boolean {
  try {
    return localStorage.getItem(ONE_CLICK_KEY) === '1'
  } catch {
    return false
  }
}

interface OneClickState {
  armed: boolean
  setArmed(next: boolean): void
}

export const useOneClickStore = create<OneClickState>((set) => ({
  armed: readArmed(),
  setArmed: (next) => {
    try {
      localStorage.setItem(ONE_CLICK_KEY, next ? '1' : '0')
    } catch {
      // Storage refused: the switch holds for this visit.
    }
    set({ armed: next })
  },
}))

/** Whether the current One-Click state should skip a confirmation. */
export function oneClickSkipConfirm(): boolean {
  return useOneClickStore.getState().armed
}
