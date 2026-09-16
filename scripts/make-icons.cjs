/**
 * Turn the two SVGs in `icons/` into the rasters macOS actually wants.
 *
 *   npm run icons
 *
 * Two outputs, for two very different consumers:
 *
 *   build/icon.png            1024×1024, the app icon. electron-builder picks
 *                             this up from `buildResources` by name and makes
 *                             the .icns itself, so there is no iconutil step
 *                             and no iconset to keep in sync.
 *   src/main/services/tray-icon.ts   the menu-bar mark, as base64 in a module.
 *
 * ### Why the tray icon is source rather than a file
 *
 * A `Tray` needs an image at runtime, and a path that resolves in `npm run dev`
 * is not the path that resolves inside a packaged .app — `out/` is bundled,
 * `icons/` is not shipped, and `extraResources` would mean one more thing that
 * is correct until somebody moves it. Two kilobytes of base64 in a module that
 * electron-vite bundles with everything else has no such failure mode.
 *
 * ### Why Electron does the rasterising
 *
 * It is already a devDependency, and it is the same renderer that will draw
 * every other pixel in this app — so what comes out here is what would have
 * come out on screen. `qlmanage` is on every Mac and would have done, but it
 * decides its own padding and background, and an icon is exactly the artefact
 * where "roughly right" shows.
 *
 * Run it after changing anything in `icons/`. It is not part of `build`,
 * deliberately: rasters are committed, so a checkout builds without needing a
 * working Electron download.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/**
 * The menu bar draws at 22pt, so 22 and 44 are the two sizes macOS asks for.
 * Anything larger is thrown away; anything smaller is blurred back up.
 */
const TRAY_PT = 22

/**
 * How big the offscreen window is, whatever size is actually wanted.
 *
 * A `BrowserWindow` cannot be 22×22 — macOS enforces a minimum and the load
 * fails outright with `ERR_FAILED` — so everything is drawn once at a size the
 * window server is happy with and resized down afterwards. That is the better
 * order anyway: one render at high resolution, downsampled, beats asking a
 * rasteriser for 22 pixels and hoping.
 */
const CANVAS = 1024

/**
 * One window, reused.
 *
 * Creating a second offscreen `BrowserWindow` after destroying the first fails
 * the load outright with `ERR_FAILED` — the first render always works and every
 * one after it does not. Loading a new URL into the same window has no such
 * problem, and there was never a reason to want four windows.
 */
function makeWindow() {
  return new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: false }
  })
}

async function render(win, svgPath, size) {
  const svg = fs.readFileSync(svgPath, 'utf8')
  // Transparent, square, with the art filling it. `contain` keeps a non-square
  // drawing centred rather than stretched — neither of these two is square once
  // the credit block is gone.
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:transparent; width:${CANVAS}px; height:${CANVAS}px; }
  img { width:${CANVAS}px; height:${CANVAS}px; object-fit:contain; display:block; }
</style>
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`

  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  // One frame is not always enough for an <img> that is still decoding, and a
  // half-decoded icon is a blank one.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const image = await win.webContents.capturePage()
  return size === CANVAS ? image : image.resize({ width: size, height: size, quality: 'best' })
}

/**
 * Crop away the empty space around the drawing, then pad it back evenly.
 *
 * The menu bar gives an icon 22 points and no more, so every pixel the artwork
 * does not use is a pixel the mark is smaller by. These SVGs draw into part of
 * a 100×100 box — `top_bar.svg` uses barely a third of its height — and resized
 * straight down that becomes a speck indistinguishable from the placeholder
 * glyph it replaces. Measured from the alpha channel rather than guessed from
 * the path data, because the drawing is what matters and not what the box says.
 *
 * `pad` is a fraction of the *cropped* size, so the breathing room scales with
 * the art. Roughly 11% each side puts ~18pt of ink in a 22pt slot, which is
 * what Apple's own menu-bar icons do.
 */
function trim(image, pad = 0.11) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  let top = height
  let left = width
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (x < left) left = x
      if (x > right) right = x
    }
  }
  if (right < left || bottom < top) return image

  // Square, around the centre of the ink — so a wide drawing is not stretched
  // and a tall one is not cropped.
  const side = Math.max(right - left, bottom - top) + 1
  const grown = Math.round(side * (1 + pad * 2))
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const x = Math.max(0, Math.min(width - grown, Math.round(cx - grown / 2)))
  const y = Math.max(0, Math.min(height - grown, Math.round(cy - grown / 2)))
  const size = Math.min(grown, width - x, height - y)
  return image.crop({ x, y, width: size, height: size })
}

async function main() {
  const appSvg = path.join(ROOT, 'icons', 'main_app.svg')
  const traySvg = path.join(ROOT, 'icons', 'top_bar.svg')
  const win = makeWindow()

  // ---- the app icon -------------------------------------------------------
  const icon = await render(win, appSvg, 1024)
  const buildDir = path.join(ROOT, 'build')
  fs.mkdirSync(buildDir, { recursive: true })
  const iconPath = path.join(buildDir, 'icon.png')
  fs.writeFileSync(iconPath, icon.toPNG())
  console.log(`build/icon.png            1024×1024  ${icon.toPNG().length} bytes`)

  // ---- the menu-bar mark --------------------------------------------------
  const full = trim(await render(win, traySvg, CANVAS))
  const one = full.resize({ width: TRAY_PT, height: TRAY_PT, quality: 'best' })
  const two = full.resize({ width: TRAY_PT * 2, height: TRAY_PT * 2, quality: 'best' })
  win.destroy()
  const module_ = `/**
 * The menu-bar mark, base64, generated by \`npm run icons\`.
 *
 * **Do not edit.** Change \`icons/top_bar.svg\` and run the script.
 *
 * Here rather than on disk because a \`Tray\` needs an image at runtime and a
 * path that works in \`npm run dev\` is not the path that works inside a
 * packaged .app. Two kilobytes bundled with the rest of main has no such
 * failure mode.
 *
 * Two sizes because the menu bar draws at 22pt and Retina wants 44px for it.
 * Both are drawn as black-on-transparent and used as **template** images, which
 * is what lets macOS tint them for light mode, dark mode and the highlighted
 * state without Mull knowing which one it is in.
 */
export const TRAY_ICON_1X = '${one.toPNG().toString('base64')}'

export const TRAY_ICON_2X = '${two.toPNG().toString('base64')}'
`
  const modulePath = path.join(ROOT, 'src', 'main', 'services', 'tray-icon.ts')
  fs.writeFileSync(modulePath, module_)
  console.log(
    `src/main/services/tray-icon.ts  ${TRAY_PT}px + ${TRAY_PT * 2}px  ` +
      `${one.toPNG().length + two.toPNG().length} bytes raw`
  )

  // Proof the render is not blank — the failure this script would otherwise
  // hide, because a transparent PNG of the right size looks entirely healthy
  // from the outside.
  for (const [name, image] of [['app', icon], ['tray 1x', one], ['tray 2x', two]]) {
    if (image.isEmpty()) throw new Error(`${name} rendered empty`)
    const { width, height } = image.getSize()
    // Once. `toBitmap()` allocates width×height×4 bytes every call, so reading
    // it inside the loop is four million allocations of four megabytes — which
    // does not fail, it simply never finishes.
    const bitmap = image.toBitmap()
    let ink = 0
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] > 0) ink += 1
    if (ink === 0) throw new Error(`${name} rendered fully transparent — nothing drawn`)
    console.log(
      `  ${name}: ${width}×${height}, ${Math.round((ink / (width * height)) * 100)}% covered`
    )
  }
}

app.disableHardwareAcceleration()
app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
