/**
 * Patches app-builder-lib (electron-builder 25.x) so the Windows NSIS target
 * can be built on Linux WITHOUT wine:
 *
 *   NsisTarget normally extracts the uninstaller by RUNNING the freshly built
 *   installer under wine. On macOS Catalina+ electron-builder already ships a
 *   pure-JS extractor (UninstallerReader). This patch routes Linux through the
 *   same extractor.
 *
 * Applied automatically before packaging (`npm run dist`). Re-run manually if
 * you reinstall node_modules:  node scripts/patch-nsis-linux.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = path.join(
  root,
  'node_modules',
  'app-builder-lib',
  'out',
  'targets',
  'nsis',
  'NsisTarget.js',
)

const WINE_CALL =
  'await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });'
const READER_CALL = 'await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);'

if (!fs.existsSync(target)) {
  console.error('[patch-nsis] app-builder-lib not installed — skipping')
  process.exit(0)
}

let src = fs.readFileSync(target, 'utf8')
if (src.includes(READER_CALL) && !src.includes(WINE_CALL)) {
  console.log('[patch-nsis] already applied')
  process.exit(0)
}
if (!src.includes(WINE_CALL)) {
  console.error('[patch-nsis] expected pattern not found — app-builder-lib version changed?')
  process.exit(1)
}

src = src.replace(WINE_CALL, READER_CALL)
fs.writeFileSync(target, src)
console.log('[patch-nsis] patched NsisTarget.js — wine is no longer required on Linux')
