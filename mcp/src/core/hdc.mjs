// hdc core for the standalone MCP server: discovery, command running, target
// resolution, and the process-level device memory.
//
// Unlike the DSH plugin, hdc is NOT launched through a host shell: the binary
// is spawned with an argv array, so no host quoting is applied to hdc
// arguments and the bytes handed to `hdc shell` reach the on-device shell
// verbatim. That removes the PowerShell-vs-POSIX quoting mismatch the plugin
// had to work around.
//
// createHdcCore(deps) returns a closure keeping its own state; deps:
//   runArgv(file, argv, opts) -> Promise<result>   (spawn, argv array)
//   runShell(command, opts)    -> Promise<result>   (host shell, PATH probe)
//   extraRoots (optional, () => string[] additional SDK roots to probe)
//   log (optional, defaults to stderr logging)

import { hdcCandidates, VER_RE, HDC_NOT_FOUND } from './hdc-discover.mjs'

export function createHdcCore(deps) {
  const { runArgv, runShell, extraRoots, log = () => {} } = deps
  let hdcPath = null
  let hdcError = ''
  let retrying = null
  const diagLog = []
  function diagPush(entry) { diagLog.push(entry); if (diagLog.length > 12) diagLog.shift() }

  function candidateList() {
    let dyn = []
    if (typeof extraRoots === 'function') { try { dyn = extraRoots() || [] } catch { dyn = [] } }
    return hdcCandidates(dyn).map((entry) => (entry && entry.path) || entry).filter(Boolean)
  }

  async function tryHdcAt(path) {
    try {
      const r = await runArgv(path, ['-v'], { timeoutMs: 12000, stdoutMaxBytes: 4096 })
      const outText = (r.stdout && r.stdout.text) || ''
      const errText = (r.stderr && r.stderr.text) || ''
      const combined = (outText + '\n' + errText).trim()
      diagPush({ path, exitCode: r.exitCode, stdout: outText.slice(0, 100), stderr: errText.slice(0, 100) })
      return r.exitCode === 0 && VER_RE.test(combined)
    } catch (e) {
      diagPush({ path, threw: String((e && e.message) || e).slice(0, 160) })
      return false
    }
  }

  async function discoverHdc() {
    for (const c of candidateList()) {
      if (await tryHdcAt(c)) { hdcPath = c; hdcError = ''; log('hdc found at ' + c); return }
    }
    const probes = process.platform === 'win32'
      ? ['where.exe hdc', 'Get-Command hdc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source']
      : ['which hdc', 'command -v hdc']
    for (const p of probes) {
      try {
        const r = await runShell(p, { timeoutMs: 12000, stdoutMaxBytes: 8192 })
        const first = ((r.stdout && r.stdout.text) || '')
          .split(/\r?\n/).map((s) => s.trim())
          .filter((s) => s && /[\\/]/.test(s))[0]
        if (r.exitCode === 0 && first && await tryHdcAt(first)) {
          hdcPath = first; hdcError = ''; log('hdc found on PATH: ' + first); return
        }
        diagPush({ probe: p, exitCode: r.exitCode, stdout: ((r.stdout && r.stdout.text) || '').slice(0, 100), stderr: ((r.stderr && r.stderr.text) || '').slice(0, 100) })
      } catch (e) {
        diagPush({ probe: p, threw: String((e && e.message) || e).slice(0, 160) })
      }
    }
    hdcError = HDC_NOT_FOUND
    log(hdcError)
  }

  async function ensureHdc() {
    if (hdcPath) return hdcPath
    if (!retrying) {
      retrying = discoverHdc().finally(() => { retrying = null })
    }
    await retrying
    return hdcPath
  }

  const TARGET_RE = /^[A-Za-z0-9._:\-\[\]]{1,80}$/

  // Run hdc with an argv array. `opts.target` becomes the `-t <id>` pair.
  async function runHdc(argv, opts = {}) {
    if (!hdcPath) {
      return { ok: false, exitCode: null, stdout: '', stderr: hdcError || HDC_NOT_FOUND, timedOut: false, aborted: false }
    }
    const full = []
    if (opts.target) {
      if (!TARGET_RE.test(opts.target)) {
        return { ok: false, exitCode: null, stdout: '', stderr: 'invalid target id', timedOut: false, aborted: false }
      }
      full.push('-t', opts.target)
    }
    full.push(...argv)
    let result
    try {
      result = await runArgv(hdcPath, full, {
        timeoutMs: opts.timeoutMs || 30000,
        stdoutMaxBytes: opts.stdoutMaxBytes || 262144,
      })
    } catch (e) {
      return { ok: false, exitCode: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false, aborted: false }
    }
    const out = (result.stdout && result.stdout.text) || ''
    const err = (result.stderr && result.stderr.text) || ''
    return {
      ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      stdout: out,
      stderr: err,
      stdoutTruncated: (result.stdout && result.stdout.truncated) === true,
    }
  }

  async function listTargets() {
    const r = await runHdc(['list', 'targets', '-v'], { timeoutMs: 20000, stdoutMaxBytes: 65536 })
    const targets = []
    if (r.ok) {
      let lines = r.stdout.split(/\r?\n/)
      if (!lines.some((l) => l.trim() && l.trim() !== '[Empty]')) lines = lines.concat(r.stderr.split(/\r?\n/))
      for (const raw of lines) {
        const parts = raw.trim().split(/\s+/).filter(Boolean)
        // Skip probe-banner rows (e.g. a stray `Ver:` line) so only
        // device-shaped ids are admitted.
        if (parts.length >= 2 && parts[0] !== '[Empty]' && !/^[A-Za-z]+:$/.test(parts[0])) {
          targets.push({ id: parts[0], type: parts[1] || '', state: parts[2] || '', addr: parts[3] || '' })
        }
      }
    }
    return { ok: r.ok, targets, error: r.ok ? '' : (r.stderr || r.stdout || 'hdc list targets failed') }
  }

  function pickTarget(list, requested) {
    if (requested) return requested
    const connected = list.find((t) => /connected/i.test(t.state))
    return connected ? connected.id : (list[0] ? list[0].id : '')
  }

  // Process-level device memory: the last explicitly used target, reused by
  // every tool call that omits `target`.
  let preferredTarget = ''

  async function currentTarget(requested) {
    const list = await listTargets()
    const clean = requested ? String(requested).trim() : ''
    if (clean) {
      preferredTarget = clean
      return { target: clean, error: '' }
    }
    if (preferredTarget && list.targets.some((t) => t.id === preferredTarget && /connected/i.test(t.state))) {
      return { target: preferredTarget, error: '' }
    }
    const target = pickTarget(list.targets, '')
    if (!target) {
      return { target: '', error: 'No HarmonyOS device/emulator connected. Connect one (hdc_connect 127.0.0.1:5555 for an emulator) or start a DevEco emulator.' }
    }
    preferredTarget = target
    return { target, error: '' }
  }

  return {
    ensureHdc,
    runHdc,
    listTargets,
    pickTarget,
    currentTarget,
    candidateList,
    hdcPathRef: () => hdcPath,
    hdcErrorRef: () => hdcError,
    diagLogRef: () => diagLog,
    getPreferred: () => preferredTarget,
    setPreferred: (t) => { if (typeof t === 'string' && t) preferredTarget = t },
  }
}
