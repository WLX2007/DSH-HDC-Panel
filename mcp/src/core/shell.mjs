// Process execution layer for the standalone MCP server.
//
// There is no DSH sandbox here: commands run directly through
// child_process.spawn. Two entry points exist:
//
//   runShellRaw(command, ...)  — a shell *string* is needed (devecocli,
//                                 hvigorw, arkts-check, directory listings).
//   runProcess(file, argv, ...) — an argv array is enough (hdc, and every
//                                 other binary that takes plain arguments).
//
// Both return the same result shape so the tool layer never has to care which
// one produced it:
//
//   { exitCode, signal, timedOut, aborted, stdout: { text, truncated },
//     stderr: { text } }
//
// IMPORTANT: this module never writes to stdout. The MCP stdio transport owns
// stdout exclusively; every diagnostic goes to stderr.

import { spawn } from 'node:child_process'
import { IS_WINDOWS, SHELL_FLAVOR } from './quoting.mjs'

export { IS_WINDOWS, SHELL_FLAVOR }

// Candidate host shells, best first.
const SHELL_CANDIDATES = IS_WINDOWS
  ? ['pwsh.exe', 'pwsh', 'powershell.exe']
  : ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh']

let shellBin = ''
let shellProbe = null

function log(message) {
  try { process.stderr.write('[dsh-hdc-mcp] ' + message + '\n') } catch { /* stderr closed */ }
}

// Probe a shell candidate with the cheapest possible command. Returns true on
// a clean exit, false when the binary does not exist.
function probeShell(bin) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, IS_WINDOWS ? ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'] : ['-c', 'exit 0'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

export async function resolveShellBin() {
  if (shellBin) return shellBin
  if (!shellProbe) {
    shellProbe = (async () => {
      for (const bin of SHELL_CANDIDATES) {
        if (await probeShell(bin)) { shellBin = bin; break }
      }
      if (!shellBin) {
        // Last resort: let the OS resolve the name at spawn time.
        shellBin = IS_WINDOWS ? 'powershell.exe' : '/bin/sh'
        log('no shell binary could be probed; falling back to ' + shellBin)
      } else {
        log('host shell: ' + shellBin + ' (' + SHELL_FLAVOR + ')')
      }
      return shellBin
    })()
  }
  await shellProbe
  return shellBin
}

function shellArgs(command) {
  if (IS_WINDOWS) return ['-NoProfile', '-NonInteractive', '-Command', command]
  return ['-c', command]
}

// Run a binary with an argv array.
export function runProcess(file, argv, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 30000
  const stdoutMaxBytes = Number(opts.stdoutMaxBytes) || 262144
  const stderrMaxBytes = Math.max(4096, Math.floor(stdoutMaxBytes / 4))
  const cwd = opts.cwd || undefined

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, argv, {
        cwd,
        env: opts.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ exitCode: null, signal: null, timedOut: false, aborted: false, stdout: { text: '', truncated: false }, stderr: { text: String((e && e.message) || e) }, spawnError: String((e && e.message) || e) })
      return
    }

    let out = ''
    let err = ''
    let outBytes = 0
    let errBytes = 0
    let outTruncated = false
    let errTruncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        // Keep draining the pipe after the cap is reached — pausing it would
        // fill the OS pipe buffer and block the child forever. The excess is
        // discarded, not stored.
        if (outTruncated) return
        const size = Buffer.byteLength(chunk, 'utf8')
        if (outBytes + size > stdoutMaxBytes) {
          const room = Math.max(0, stdoutMaxBytes - outBytes)
          out += room > 0 ? chunk.slice(0, room) : ''
          outBytes = stdoutMaxBytes
          outTruncated = true
          return
        }
        outBytes += size
        out += chunk
      })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        if (errTruncated) return
        const size = Buffer.byteLength(chunk, 'utf8')
        if (errBytes + size > stderrMaxBytes) {
          errTruncated = true
          return
        }
        errBytes += size
        err += chunk
      })
    }

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: code === null || code === undefined ? null : code,
        signal: signal || null,
        timedOut,
        aborted: false,
        stdout: { text: out, truncated: outTruncated },
        stderr: { text: err, truncated: errTruncated },
      })
    }

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        aborted: false,
        stdout: { text: out, truncated: outTruncated },
        stderr: { text: err + String((e && e.message) || e) },
        spawnError: String((e && e.message) || e),
      })
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

// Run a command through the host shell (needed for env-var prefixes, `&&`
// chains and PowerShell-only syntax).
export async function runShellRaw(command, timeoutMs = 30000, stdoutMaxBytes = 262144, workdir = '') {
  const bin = await resolveShellBin()
  return runProcess(bin, shellArgs(command), { timeoutMs, stdoutMaxBytes, cwd: workdir || undefined })
}

// Run a command through the host shell with extra environment variables.
export async function runShellRawEnv(command, env, timeoutMs = 30000, stdoutMaxBytes = 262144, workdir = '') {
  const bin = await resolveShellBin()
  return runProcess(bin, shellArgs(command), {
    timeoutMs,
    stdoutMaxBytes,
    cwd: workdir || undefined,
    env: Object.assign({}, process.env, env || {}),
  })
}

export { log }
