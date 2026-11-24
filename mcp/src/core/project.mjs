// Project-level helpers shared by the tool groups: locating the HarmonyOS
// application root, collecting .ets sources, finding build artifacts and
// reading the bundle/ability names from the project manifests.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WALK_SKIP_DIRS = new Set(['oh_modules', 'node_modules', '.hvigor', '.idea', '.git', '.cxx'])

export function walkDir(dir, fileTest, out, depth = 0) {
  if (depth > 12) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (WALK_SKIP_DIRS.has(e.name)) continue
      walkDir(p, fileTest, out, depth + 1)
    } else if (e.isFile() && fileTest(p)) {
      out.push(p)
    }
  }
}

/**
 * Stage app root, or project root with hvigor OHPM metadata (not a submodule
 * folder).
 */
export function isHarmonyApplicationRoot(dir) {
  const isFile = (file) => {
    try { return statSync(file).isFile() } catch { return false }
  }
  if (isFile(join(dir, 'AppScope', 'app.json5'))) return true
  if (!isFile(join(dir, 'build-profile.json5'))) return false
  return isFile(join(dir, 'oh-package.json5')) || isFile(join(dir, 'oh-package.json'))
}

// Recursively collect .ets files under entry/src/main/ets.
export function collectEtsFiles(cwd) {
  const etsRoot = join(cwd, 'entry', 'src', 'main', 'ets')
  const out = []
  walkDir(etsRoot, (p) => p.endsWith('.ets'), out, 0)
  return out.slice(0, 1000)
}

// Find the newest built .hap under the project root. Unsigned artifacts are
// NOT excluded: in practice the newest artifact is often the unsigned one,
// and picking an older signed package silently rolls the device back to
// stale code.
export function findNewestHap(cwd) {
  const out = []
  if (existsSync(cwd)) walkDir(cwd, (p) => /\.hap$/i.test(p), out, 0)
  let best = ''
  let bestM = -1
  for (const p of out) {
    try {
      const m = statSync(p).mtimeMs
      if (m > bestM) { bestM = m; best = p }
    } catch { /* skip */ }
  }
  return best
}

// Best-effort bundleName + EntryAbility read from the project manifests.
export function readBundleAndAbility(cwd) {
  let bundle = ''
  let ability = 'EntryAbility'
  try {
    const text = readFileSync(join(cwd, 'AppScope', 'app.json5'), 'utf8')
    const m = /["']bundleName["']\s*:\s*["']([A-Za-z0-9._-]+)["']/.exec(text)
    if (m) bundle = m[1]
  } catch { /* keep '' */ }
  try {
    const text = readFileSync(join(cwd, 'entry', 'src', 'main', 'module.json5'), 'utf8')
    const m = /["']name["']\s*:\s*["']([A-Za-z0-9._-]*Ability)["']/.exec(text)
    if (m) ability = m[1]
  } catch { /* keep EntryAbility */ }
  return { bundle, ability }
}
