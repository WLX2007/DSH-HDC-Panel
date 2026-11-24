// Server-scoped state for the standalone MCP server.
//
// The DSH plugin kept the HarmonyOS project root per conversation session
// (keyed by session id). An MCP server over stdio is a single-client process,
// so the same information is kept as one process-level value:
//
//   workspaceRoot — the directory the client launched the server in. It is
//                  the immutable reference point (used to report whether a
//                  project sits outside the workspace).
//   projectRoot   — the HarmonyOS project root the tools operate on. Starts
//                  at workspaceRoot and is changed by switch_cwd.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ARTIFACT_DIRNAME = '.dsh-hdc-mcp'

const workspaceRoot = process.cwd()
let projectRoot = workspaceRoot

export function getWorkspaceRoot() {
  return workspaceRoot
}

export function getProjectRoot() {
  return projectRoot
}

export function setProjectRoot(dir) {
  const value = String(dir || '').trim()
  if (value) projectRoot = value
  return projectRoot
}

export function resetProjectRoot() {
  projectRoot = workspaceRoot
  return projectRoot
}

// Where screenshots and lint reports are staged. Kept inside the project root
// so the artefacts travel with the project; add `.dsh-hdc-mcp/` to .gitignore.
export function artifactsDir() {
  return join(getProjectRoot(), ARTIFACT_DIRNAME)
}

export function screenshotsDir() {
  return join(artifactsDir(), 'screenshots')
}

export function lintReportDir() {
  return join(artifactsDir(), 'lint')
}

export function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

// Normalised comparison helper: is `candidate` inside `root`?
export function pathInside(root, candidate) {
  const norm = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const r = norm(root)
  const c = norm(candidate)
  if (!r || !c) return false
  return c === r || c.startsWith(r + '\\')
}
