import { Minus, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Titlebar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="drag-region flex h-11 shrink-0 items-center justify-between border-b bg-card/60 pl-4">
      <div className="flex items-center gap-2.5 overflow-hidden">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/90">
          <div className="h-2 w-2 rounded-[2px] bg-primary-foreground" />
        </div>
        <div className="min-w-0">
          <span className="block truncate text-[13px] font-semibold leading-none">{title}</span>
          {subtitle && (
            <span className="mt-0.5 block truncate text-[10px] leading-none text-muted-foreground">
              {subtitle}
            </span>
          )}
        </div>
      </div>
      <div className="no-drag-region flex h-full">
        <WindowButton onClick={() => void window.screenforge.window.minimize()} label="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </WindowButton>
        <WindowButton onClick={() => void window.screenforge.window.maximizeToggle()} label="Maximize">
          <Square className="h-3 w-3" />
        </WindowButton>
        <WindowButton
          onClick={() => void window.screenforge.window.close()}
          label="Close"
          danger
        >
          <X className="h-4 w-4" />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton({
  children,
  onClick,
  label,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex h-full w-11 items-center justify-center text-muted-foreground transition-colors',
        danger ? 'hover:bg-destructive hover:text-destructive-foreground' : 'hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
