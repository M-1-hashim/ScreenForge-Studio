/**
 * Icon pipeline: resources/icon-source.png (1024px, AI-generated master)
 *   -> resources/icon.ico   (multi-size Windows ICO for the NSIS installer + exe)
 *   -> resources/icon.png   (256px, used by electron-builder / window icon)
 *
 * Run:  node scripts/make-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import png2icons from 'png2icons'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'resources', 'icon-source.png')

if (!fs.existsSync(src)) {
  console.error(`[make-icons] missing master icon: ${src}`)
  process.exit(1)
}

const img = await loadImage(src)

// 256px PNG (exact resize through the Skia canvas).
const c256 = createCanvas(256, 256)
c256.getContext('2d').drawImage(img, 0, 0, 256, 256)
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), c256.toBuffer('image/png'))

// Re-encode a 512px canvas PNG (standard chunk layout) then build the
// multi-resolution ICO (16..256) with PNG compression for the large sizes.
const c512 = createCanvas(512, 512)
c512.getContext('2d').drawImage(img, 0, 0, 512, 512)
const png512 = c512.toBuffer('image/png')
const ico = png2icons.createICO(png512, png2icons.BICUBIC, 0, true, false)
if (!ico) {
  console.error('[make-icons] ICO conversion failed')
  process.exit(1)
}
fs.writeFileSync(path.join(root, 'resources', 'icon.ico'), ico)

console.log(`[make-icons] wrote icon.ico (${ico.length} B) and icon.png (256px)`)
