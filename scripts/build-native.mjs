/**
 * Native addon build helper.
 *
 * The optional Windows addons under native/ (wgc_capture, cursor_hook,
 * wasapi_capture) require a Windows machine with:
 *   - Node.js x64 + Visual Studio 2022 "Desktop development with C++"
 *   - Windows SDK 10.0.19041 or newer
 *
 * Build them with:
 *   cd native/<addon>
 *   npx node-gyp configure --arch=x64
 *   npx node-gyp build
 *   -> native/<addon>/build/Release/<addon>.node
 *
 * Then either:
 *   - copy the .node into resources/native/ so electron-builder ships it via
 *     extraResources (loaded at runtime by src/main/native/loader.ts), or
 *   - set SCREENFORGE_NATIVE_DIR when running from a dev checkout.
 *
 * This script exists so `npm run native:build` works from the repo root on a
 * Windows dev box; on other platforms it exits with guidance (the app runs
 * fully without the addons — capture falls back to desktopCapturer and cursor
 * events fall back to high-frequency polling).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const addons = ['wgc_capture', 'cursor_hook', 'wasapi_capture']

if (process.platform !== 'win32') {
  console.log(
    '[native] Native Windows addons must be built on Windows (MSVC + Windows SDK).\n' +
      '[native] The application works without them: capture uses the desktopCapturer\n' +
      '[native] backend and cursor tracking uses polling. See scripts/build-native.mjs.',
  )
  process.exit(0)
}

const nodeGyp = path.join(root, 'node_modules', '.bin', 'node-gyp.CMD')
const hasNodeGyp = fs.existsSync(nodeGyp)

for (const addon of addons) {
  const dir = path.join(root, 'native', addon)
  if (!fs.existsSync(path.join(dir, 'binding.gyp'))) continue
  console.log(`[native] building ${addon}...`)
  const res = spawnSync(
    hasNodeGyp ? nodeGyp : 'node-gyp',
    ['configure', 'build', '--arch=x64'],
    { cwd: dir, stdio: 'inherit', shell: true },
  )
  if (res.status !== 0) {
    console.error(`[native] ${addon} build failed — continuing (fallbacks remain active)`)
  }
}
console.log('[native] done.')
