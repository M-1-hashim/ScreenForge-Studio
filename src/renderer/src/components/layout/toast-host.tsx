import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toast-store'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

const ICONS = {
  default: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const

const COLORS = {
  default: 'text-muted-foreground',
  success: 'text-success',
  error: 'text-destructive',
} as const

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant]
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur',
              'animate-slide-up',
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', COLORS[t.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-tight">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
