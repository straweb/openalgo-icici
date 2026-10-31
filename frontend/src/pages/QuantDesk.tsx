import { useEffect, useState } from 'react'
import { setApiKey, setIdentity } from '@/components/quantdesk/lib/client-api'
import { ensureSocket, setFeedCredentials } from '@/components/quantdesk/lib/socket'
import { useTerminal } from '@/components/quantdesk/lib/store'
import { TerminalView } from '@/components/quantdesk/widgets/TerminalView'

/**
 * QuantDesk — the vendored quanttrade terminal as an OpenAlgo page.
 *
 * Boot order matters: the OpenAlgo session's api key + websocket URL are
 * fetched first and injected into the quantdesk adapters (REST + feed),
 * the workspace store rehydrates from localStorage, then the terminal
 * renders. The host layout (FullWidthLayout) already enforces the login
 * + broker redirects and mounts the socket.io provider that order
 * updates ride.
 */
export default function QuantDesk() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setKey] = useState('')
  const [wsUrl, setWsUrl] = useState('')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [keyRes, cfgRes, sessionRes] = await Promise.all([
          fetch('/api/websocket/apikey').then((r) => r.json()),
          fetch('/api/websocket/config').then((r) => r.json()),
          fetch('/auth/session-status', { credentials: 'include' })
            .then((r) => r.json())
            .catch(() => ({})),
        ])
        if (!live) return
        const key: string = keyRes.api_key ?? ''
        const url: string = cfgRes.websocket_url || 'ws://127.0.0.1:8765'
        if (!key) throw new Error('OpenAlgo session has no API key — log in again')
        setApiKey(key)
        setFeedCredentials(url, key)
        const username: string = sessionRes?.user?.username ?? 'trader'
        const broker: string = sessionRes?.user?.broker ?? 'openalgo'
        setIdentity(username, broker)
        setKey(key)
        setWsUrl(url)
        // rehydrate the persisted workspaces, then connect the feed
        void useTerminal.persist.rehydrate()
        ensureSocket()
        setReady(true)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'QuantDesk failed to start')
      }
    })()
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="qd-root h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
      {error && (
        <div className="m-auto text-center text-[13px] text-destructive max-w-sm">
          {error}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="block mx-auto mt-2 px-3 py-1 rounded bg-secondary text-foreground text-[12px]"
          >
            Retry
          </button>
        </div>
      )}
      {!error && !ready && (
        <div className="m-auto text-center text-[13px] text-muted-foreground">
          <div className="text-2xl font-bold text-primary mb-2">QuantDesk</div>
          connecting to OpenAlgo…
        </div>
      )}
      {!error && ready && <TerminalView apiKey={apiKey} wsUrl={wsUrl} />}
    </div>
  )
}
