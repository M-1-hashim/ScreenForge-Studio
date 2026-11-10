import { useState } from 'react'
import { cn } from '@/lib/utils'

interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  className?: string
  disabled?: boolean
}

/**
 * Small controlled color control: swatch + native color input + hex field.
 */
export function ColorPicker({ value, onChange, className, disabled }: ColorPickerProps) {
  const [text, setText] = useState(value)

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md border">
        <div className="absolute inset-0" style={{ backgroundColor: value }} />
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            onChange(e.target.value)
          }}
          aria-label="Pick a color"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <input
        type="text"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value)
          const hex = e.target.value.trim()
          if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
            onChange(hex)
          }
        }}
        onBlur={() => setText(value)}
        aria-label="Hex color"
        className="h-8 w-24 rounded-md border bg-transparent px-2 font-mono text-xs text-foreground disabled:opacity-50"
      />
    </div>
  )
}
