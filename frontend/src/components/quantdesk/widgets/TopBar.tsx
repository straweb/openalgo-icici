import {
  Boxes,
  CandlestickChart,
  ChevronDown,
  FileStack,
  Key,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  User,
  Workflow,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { UnderlyingPicker } from './UnderlyingPicker'
import { WorkspaceTabs } from './WorkspaceTabs'

// Top bar: logo at the left, workspace tabs beside it, underlying +
// series selection and the page menu at the right (OpenAlgo pages,
// profile, master contracts, logout).
export function TopBar() {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [clock, setClock] = useState('')

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }))
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-qd-menu]')) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const items: { label: string; icon: typeof LayoutDashboard; path: string }[] = [
    { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
    { label: 'Terminal', icon: CandlestickChart, path: '/trading' },
    { label: 'Admin', icon: Settings, path: '/admin' },
    { label: 'Strategy Builder', icon: Workflow, path: '/flow' },
    { label: 'Strategies', icon: Boxes, path: '/strategy' },
    { label: 'API Key', icon: Key, path: '/apikey' },
    { label: 'Profile', icon: User, path: '/profile' },
    { label: 'Master Contracts', icon: FileStack, path: '/master-contract' },
  ]

  return (
    <header className="flex items-center gap-2 px-3 h-11 border-b border-border bg-card shrink-0">
      {/* logo */}
      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        className="flex items-center gap-1.5 shrink-0"
        title="QuantDesk — OpenAlgo"
      >
        <span className="h-5 w-5 rounded bg-primary/90 text-primary-foreground grid place-items-center text-[11px] font-bold">
          Q
        </span>
        <span className="text-[13px] font-semibold tracking-tight">QuantDesk</span>
        <span className="text-[9px] text-muted-foreground hidden xl:inline">openalgo</span>
      </button>

      {/* workspace tabs */}
      <div className="min-w-0 flex-1 flex items-center justify-center">
        <WorkspaceTabs />
      </div>

      {/* right: underlying + series selection */}
      <div className="flex items-center gap-2 shrink-0">
        <UnderlyingPicker />
        <span className="text-[10px] tabular text-muted-foreground hidden lg:inline">{clock}</span>
        {/* page menu */}
        <div className="relative" data-qd-menu>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-1 px-2 py-1.5 rounded bg-secondary/70 hover:bg-secondary text-foreground"
            title="Pages — dashboard, terminal, admin, strategy builder, API key, profile, master contracts, logout"
          >
            <Menu className="h-4 w-4" />
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg p-1">
              {items.map((it) => (
                <button
                  key={it.path}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    navigate(it.path)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-secondary text-left"
                >
                  <it.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {it.label}
                </button>
              ))}
              <div className="h-px bg-border my-1" />
              <button
                type="button"
                onClick={async () => {
                  setMenuOpen(false)
                  await fetch('/logout', { method: 'GET', credentials: 'include' }).catch(
                    () => undefined
                  )
                  navigate('/login')
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-secondary text-left text-destructive"
              >
                <LogOut className="h-3.5 w-3.5" />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
