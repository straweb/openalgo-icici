/**
 * The deploy panel's index chart — the underlying's own candles, riding
 * above the strike ladder while an F&O underlying is selected.
 *
 * The trader sizes strikes against the index's move, so the index lives in
 * the panel: no tab switch, no chart pane sacrificed. It is a read-only
 * OpenAlgoChart over a spot feed (history REST + one LTP socket), with the
 * small set of controls that survive at panel height: the interval pills
 * and a fold. Everything else the full panes already do better.
 *
 * The choice (interval, folded or not) persists per browser, not per
 * underlying — the panel is one surface and these are its own habits.
 */

import { ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { OpenAlgoChart } from '@/components/chart/OpenAlgoChart'
import { createSpotFeed } from '@/lib/trading/spotFeed'
import { cn } from '@/lib/utils'

const INTERVALS = ['1m', '5m', '15m'] as const

const LS_KEY = 'oa-deploy-indexchart'

interface Saved {
  interval?: string
  folded?: boolean
}

function readSaved(): Saved {
  try {
    const raw = globalThis.localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as Saved) : {}
  } catch {
    return {}
  }
}

function writeSaved(next: Saved): void {
  try {
    globalThis.localStorage.setItem(LS_KEY, JSON.stringify(next))
  } catch {
    // Storage refused: the choice holds for this visit.
  }
}

interface Props {
  apiKey: string
  wsUrl: string
  symbol: string
  exchange: string
  name?: string | null
}

export function DeployIndexChart({ apiKey, wsUrl, symbol, exchange, name }: Props) {
  const initial = useRef(readSaved())
  const [interval, setInterval] = useState(initial.current.interval ?? '5m')
  const [folded, setFolded] = useState(initial.current.folded ?? false)
  /** One feed per mount; the instrument change is a setSymbol, not a rebuild. */
  const feed = useMemo(() => createSpotFeed({ apiKey, wsUrl }), [apiKey, wsUrl])

  const setIntervalAndSave = (iv: string) => {
    setInterval(iv)
    writeSaved({ ...readSaved(), interval: iv })
  }
  const setFoldedAndSave = (v: boolean) => {
    setFolded(v)
    writeSaved({ ...readSaved(), folded: v })
  }

  return (
    <div className="shrink-0 border-b bg-muted/20">
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {name || symbol}
        </span>
        <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{exchange}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              onClick={() => setIntervalAndSave(iv)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[9px] font-semibold transition-colors',
                iv === interval
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              aria-pressed={iv === interval}
            >
              {iv}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFoldedAndSave(!folded)}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={folded ? 'Show the index chart' : 'Fold the index chart'}
            aria-label={folded ? 'Show the index chart' : 'Fold the index chart'}
          >
            {folded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>
        </div>
      </div>
      {!folded && (
        // The strip is a positioned flex column of its own: the chart root's
        // `relative` resolves against it, so the candles stay in the 170px
        // band and cannot paint over the header, the ladder or the deploy
        // buttons the way an absolute fill of the panel's aside did.
        <div className="flex h-[170px] flex-col overflow-hidden">
          <OpenAlgoChart
            feed={feed}
            symbol={symbol}
            exchange={exchange}
            interval={interval}
            persistKey={`oa-deploy-index-${exchange}-${symbol}`}
            rail={false}
            statusline={false}
            indicators={false}
            volume
          />
        </div>
      )}
    </div>
  )
}
