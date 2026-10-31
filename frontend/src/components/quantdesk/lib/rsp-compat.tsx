import type { CSSProperties, ReactNode } from 'react'
import { Group, Panel as RspPanel, Separator } from 'react-resizable-panels'

// ============================================================
// react-resizable-panels v3 -> v4 compatibility shim.
// The vendored quanttrade terminal was written against the v3 API
// (`PanelGroup` / `PanelResizeHandle`, numeric sizes in percent).
// v4 renames the exports (`Group` / `Separator`) and interprets
// numeric size props as pixels — this shim restores the v3 surface
// so the ported panels compile and behave exactly as upstream.
// ============================================================

/** v3 accepted numbers as percents and strings verbatim; v4 numbers are px. */
function sizeProp(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined
  return typeof v === 'number' ? `${v}%` : v
}

export function PanelGroup(props: {
  direction?: 'horizontal' | 'vertical'
  orientation?: 'horizontal' | 'vertical'
  className?: string
  style?: CSSProperties
  id?: string
  children?: ReactNode
}) {
  const { direction, orientation, ...rest } = props
  return <Group orientation={orientation ?? direction ?? 'horizontal'} {...rest} />
}

export function Panel(props: {
  defaultSize?: number | string
  minSize?: number | string
  maxSize?: number | string
  collapsible?: boolean
  collapsedSize?: number | string
  className?: string
  style?: CSSProperties
  id?: string
  children?: ReactNode
}) {
  const { defaultSize, minSize, maxSize, collapsible, collapsedSize, ...rest } = props
  return (
    <RspPanel
      defaultSize={sizeProp(defaultSize)}
      minSize={sizeProp(minSize)}
      maxSize={sizeProp(maxSize)}
      collapsible={collapsible}
      collapsedSize={sizeProp(collapsedSize)}
      {...rest}
    />
  )
}

export function PanelResizeHandle(props: {
  className?: string
  style?: CSSProperties
  id?: string
  children?: ReactNode
}) {
  return <Separator {...props} />
}
