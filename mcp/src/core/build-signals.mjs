// Build/deploy success signals shared by the toolchain and compile groups.
//
// devecocli and hvigor exit non-zero when warnings are present even after a
// successful build (observed live: BUILD SUCCESSFUL + exit 1), so success is
// judged by output markers — the same philosophy the hdc tools use.

import { statSync } from 'node:fs'

export const BUILD_OK_RE = /BUILD SUCCESSFUL|Build completed successfully/i
export const BUILD_FAIL_RE = /BUILD FAILED|FAILURE: Build failed|hvigor ERROR/i

export function buildOk(r) {
  const text = (r.stdout || '') + '\n' + (r.stderr || '')
  return !r.timedOut && !BUILD_FAIL_RE.test(text) && (r.exitCode === 0 || BUILD_OK_RE.test(text))
}

export function buildResultOk(r) {
  const text = ((r && r.stdout) || '') + '\n' + ((r && r.stderr) || '')
  return text.trim().length > 0 && buildOk(r)
}

// devecocli's native mojo platform channel can die on a locked-down host
// (named-pipe denial). The marker is detected so callers can tell
// "build ok but the channel died" from a clean build.
const MOJO_FATAL_RE = /FATAL:[^\r\n]*platform_channel|platform_channel[^\r\n]*(?:拒绝访问|denied)/i

export function mojoFatal(r) {
  const t = ((r && r.stdout) || '') + '\n' + ((r && r.stderr) || '')
  return MOJO_FATAL_RE.test(t)
}

export function remoteStartFailure(text) {
  return /(?:failed to start ability|error code:\s*\d+|error:\s*failed|unlock screen failed|screen is locked|unable to start ability)/i.test(String(text || ''))
}

export function bundlePattern(bundle) {
  return new RegExp(String(bundle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

export function tryParseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

export function statMtimeMs(p) {
  try { return statSync(p).mtimeMs } catch { return -1 }
}
