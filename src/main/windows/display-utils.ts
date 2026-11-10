/**
 * Display helpers.
 *
 * Electron reports bounds in DIP (device-independent pixels). Cursor events
 * and regions are stored in PHYSICAL pixels within the virtual desktop, whose
 * origin is the top-left of the primary display. These helpers convert
 * between the two spaces and package displays for the renderer.
 */
import { screen } from 'electron'
import type { DisplayInfo, Rect } from '../../shared/types'

export interface VirtualOrigin {
  x: number
  y: number
}

/** Origin of the virtual desktop in DIP space (top-left of primary display). */
export function virtualOrigin(): VirtualOrigin {
  const primary = screen.getPrimaryDisplay()
  return { x: primary.bounds.x, y: primary.bounds.y }
}

/** Convert a DIP rect (Electron screen space) to virtual-desktop physical px. */
export function dipRectToPhysical(
  dipRect: Rect,
  scaleFactor: number,
  origin: VirtualOrigin = virtualOrigin(),
): Rect {
  return {
    x: Math.round((dipRect.x - origin.x) * scaleFactor),
    y: Math.round((dipRect.y - origin.y) * scaleFactor),
    width: Math.round(dipRect.width * scaleFactor),
    height: Math.round(dipRect.height * scaleFactor),
  }
}

/** Convert virtual-desktop physical px back to DIP for window positioning. */
export function physicalRectToDipRect(
  physical: Rect,
  scaleFactor: number,
  origin: VirtualOrigin = virtualOrigin(),
): Rect {
  return {
    x: origin.x + physical.x / scaleFactor,
    y: origin.y + physical.y / scaleFactor,
    width: physical.width / scaleFactor,
    height: physical.height / scaleFactor,
  }
}

export function getDisplays(): DisplayInfo[] {
  const origin = virtualOrigin()
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, index) => {
    const physicalBounds = dipRectToPhysical(d.bounds, d.scaleFactor, origin)
    return {
      id: d.id,
      label:
        d.label ||
        `Display ${index + 1}${d.id === primaryId ? ' (Primary)' : ''}`,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primaryId,
      physicalBounds,
    }
  })
}

/** Which display contains a physical virtual-desktop point. */
export function displayAtPhysicalPoint(
  displays: DisplayInfo[],
  x: number,
  y: number,
): DisplayInfo | null {
  for (const d of displays) {
    const b = d.physicalBounds
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return d
  }
  return null
}
