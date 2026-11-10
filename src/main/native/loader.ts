/**
 * Native addon loader.
 *
 * Native Windows addons (cursor hook, WASAPI capture, WGC capture) are
 * optional runtime enhancements. The app is fully functional without them —
 * each consumer degrades gracefully. Loading never throws.
 *
 * Search order:
 *   1. $SCREENFORGE_NATIVE_DIR/<name>.node
 *   2. <process.resourcesPath>/native/<name>.node        (packaged app)
 *   3. <appPath>/native/<name>/build/Release/<name>.node (dev checkout)
 */
import path from 'node:path'
import fs from 'node:fs'

const failedOnce = new Set<string>()

function candidatesFor(name: string): string[] {
  const out: string[] = []
  const file = `${name}.node`
  if (process.env.SCREENFORGE_NATIVE_DIR) {
    out.push(path.join(process.env.SCREENFORGE_NATIVE_DIR, file))
  }
  if (process.resourcesPath) {
    out.push(path.join(process.resourcesPath, 'native', file))
  }
  try {
    // Lazily require electron so this module stays testable in plain Node.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    if (app?.getAppPath) {
      out.push(path.join(app.getAppPath(), 'native', name, 'build', 'Release', file))
    }
  } catch {
    /* electron not available (tests) */
  }
  out.push(path.join(__dirname, '..', '..', '..', 'native', name, 'build', 'Release', file))
  return out
}

export function loadNativeAddon(name: string): unknown | null {
  for (const candidate of candidatesFor(name)) {
    try {
      if (!fs.existsSync(candidate)) continue
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(candidate)
      return (mod as { default?: unknown }).default ?? mod
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!failedOnce.has(name)) {
        failedOnce.add(name)
        // eslint-disable-next-line no-console
        console.warn(`[native] failed to load "${name}": ${message}`)
      }
      return null
    }
  }
  if (!failedOnce.has(name)) {
    failedOnce.add(name)
    // eslint-disable-next-line no-console
    console.info(`[native] "${name}" not available — using fallback path`)
  }
  return null
}

export function isNativeAvailable(name: string): boolean {
  return loadNativeAddon(name) !== null
}
